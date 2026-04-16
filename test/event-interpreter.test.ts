// Tests for public/js/event-interpreter.ts
// ZERO DOM DEPENDENCY — runs with node:test directly, no happy-dom.
// If any test fails with ReferenceError: document is not defined,
// it means the interpreter module has a DOM dependency that must be removed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Sentinel: verify we're running without DOM globals
assert.strictEqual(typeof document, 'undefined', 'Tests must run without DOM globals (no happy-dom)');

import {
  interpretToolCall,
  extractToolCallContent,
  getStatusIcon,
  classifyPermissionOption,
  resolvePermissionLabel,
  formatPlanEntries,
  parseDiff,
  normalizeEventsResponse,
  isPromptIdle,
} from '../public/js/event-interpreter.ts';

// --- interpretToolCall ---

describe('interpretToolCall', () => {
  it('maps known kind to icon', () => {
    const result = interpretToolCall('read', 'Read file', undefined);
    assert.equal(result.icon, 'cat');
    assert.equal(result.title, 'Read file');
    assert.equal(result.showDiff, false);
  });

  it('uses default icon for unknown kind', () => {
    const result = interpretToolCall('unknown_kind', 'Something', undefined);
    assert.equal(result.icon, 'run');
  });

  it('extracts command from rawInput with $ prefix', () => {
    const result = interpretToolCall('execute', 'Run command', { command: 'ls -la' });
    assert.equal(result.detail, 'ls -la');
    assert.equal(result.detailPrefix, '$ ');
  });

  it('extracts path from rawInput when no command', () => {
    const result = interpretToolCall('read', 'Read file', { path: 'src/foo.ts' });
    assert.equal(result.detail, 'src/foo.ts');
    assert.equal(result.detailPrefix, undefined);
  });

  it('prefers command over path', () => {
    const result = interpretToolCall('execute', 'Run', { command: 'npm test', path: '/tmp' });
    assert.equal(result.detail, 'npm test');
    assert.equal(result.detailPrefix, '$ ');
  });

  it('sets showDiff for edit kind', () => {
    const result = interpretToolCall('edit', 'Edit file', { path: 'foo.ts' });
    assert.equal(result.showDiff, true);
  });

  it('does not set showDiff for non-edit kind', () => {
    const result = interpretToolCall('read', 'Read', { path: 'foo.ts' });
    assert.equal(result.showDiff, false);
  });

  it('handles string rawInput', () => {
    const result = interpretToolCall('edit', 'Edit', '*** Begin Patch\n+added');
    assert.equal(result.detail, undefined);
    assert.equal(result.showDiff, true);
  });
});

// --- extractToolCallContent ---

describe('extractToolCallContent', () => {
  it('extracts terminal type', () => {
    const result = extractToolCallContent([{ type: 'terminal', terminalId: 't1' }]);
    assert.equal(result, '[terminal t1]');
  });

  it('extracts content.text', () => {
    const result = extractToolCallContent([{ content: { text: 'hello' } }]);
    assert.equal(result, 'hello');
  });

  it('extracts content array', () => {
    const result = extractToolCallContent([
      { content: [{ text: 'a' }, { text: 'b' }] },
    ]);
    assert.equal(result, 'ab');
  });

  it('joins multiple items with newline', () => {
    const result = extractToolCallContent([
      { content: { text: 'line1' } },
      { content: { text: 'line2' } },
    ]);
    assert.equal(result, 'line1\nline2');
  });

  it('filters empty items', () => {
    const result = extractToolCallContent([
      { content: { text: '' } },
      { content: { text: 'real' } },
    ]);
    assert.equal(result, 'real');
  });

  it('returns empty string for empty array', () => {
    assert.equal(extractToolCallContent([]), '');
  });
});

// --- getStatusIcon ---

describe('getStatusIcon', () => {
  it('returns checkmark for completed', () => {
    const result = getStatusIcon('completed');
    assert.equal(result.icon, '✓');
    assert.equal(result.className, 'tool-call completed');
  });

  it('returns cross for failed', () => {
    const result = getStatusIcon('failed');
    assert.equal(result.icon, '✗');
    assert.equal(result.className, 'tool-call failed');
  });

  it('returns ellipsis for other status', () => {
    const result = getStatusIcon('running');
    assert.equal(result.icon, '…');
    assert.equal(result.className, 'tool-call running');
  });
});

// --- classifyPermissionOption ---

describe('classifyPermissionOption', () => {
  it('classifies allow_once', () => {
    const result = classifyPermissionOption('allow_once');
    assert.equal(result.cssClass, 'allow');
    assert.equal(result.apiAction, 'resolve');
  });

  it('classifies allow_always', () => {
    const result = classifyPermissionOption('allow_always');
    assert.equal(result.cssClass, 'allow');
    assert.equal(result.apiAction, 'resolve');
  });

  it('classifies deny', () => {
    const result = classifyPermissionOption('deny');
    assert.equal(result.cssClass, 'deny');
    assert.equal(result.apiAction, 'deny');
  });

  it('classifies reject', () => {
    const result = classifyPermissionOption('reject');
    assert.equal(result.cssClass, 'deny');
    assert.equal(result.apiAction, 'deny');
  });

  it('classifies unknown kind as deny CSS + resolve API', () => {
    // Unknown kind: CSS defaults to deny (not allow), but API defaults to resolve (not deny)
    const result = classifyPermissionOption('escalate');
    assert.equal(result.cssClass, 'deny');
    assert.equal(result.apiAction, 'resolve');
  });

  it('handles empty string', () => {
    const result = classifyPermissionOption('');
    assert.equal(result.cssClass, 'deny');
    assert.equal(result.apiAction, 'resolve');
  });
});

// --- resolvePermissionLabel ---

describe('resolvePermissionLabel', () => {
  it('returns optionName when provided', () => {
    assert.equal(resolvePermissionLabel('Allow once', false), 'Allow once');
  });

  it('returns denied when no optionName and denied=true', () => {
    assert.equal(resolvePermissionLabel(undefined, true), 'denied');
  });

  it('returns allowed when no optionName and denied=false', () => {
    assert.equal(resolvePermissionLabel(undefined, false), 'allowed');
  });

  it('returns optionName even when denied=true', () => {
    assert.equal(resolvePermissionLabel('Deny', true), 'Deny');
  });
});

// --- formatPlanEntries ---

describe('formatPlanEntries', () => {
  it('maps known statuses to symbols', () => {
    const result = formatPlanEntries([
      { status: 'pending', content: 'Task 1' },
      { status: 'in_progress', content: 'Task 2' },
      { status: 'completed', content: 'Task 3' },
    ]);
    assert.deepEqual(result, [
      { symbol: '○', content: 'Task 1' },
      { symbol: '◉', content: 'Task 2' },
      { symbol: '●', content: 'Task 3' },
    ]);
  });

  it('uses ? for unknown status', () => {
    const result = formatPlanEntries([{ status: 'skipped', content: 'X' }]);
    assert.deepEqual(result, [{ symbol: '?', content: 'X' }]);
  });

  it('handles empty array', () => {
    assert.deepEqual(formatPlanEntries([]), []);
  });
});

// --- parseDiff ---

describe('parseDiff', () => {
  it('parses patch string format', () => {
    const patch = '*** Begin Patch\n*** Update File: src/foo.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line\n context\n*** End Patch';
    const result = parseDiff(patch);
    assert.ok(result);
    assert.deepEqual(result, [
      { kind: 'file', text: '*** Update File: src/foo.ts' },
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'del', text: '-old line' },
      { kind: 'add', text: '+new line' },
      { kind: 'context', text: ' context' },
    ]);
  });

  it('handles Add File and Delete File markers', () => {
    const patch = '*** Begin Patch\n*** Add File: new.ts\n+content\n*** End Patch';
    const result = parseDiff(patch);
    assert.ok(result);
    assert.equal(result[0].kind, 'file');
    assert.equal(result[0].text, '*** Add File: new.ts');
  });

  it('parses object with old_str and new_str', () => {
    const result = parseDiff({ path: 'foo.ts', old_str: 'old', new_str: 'new' });
    assert.ok(result);
    assert.deepEqual(result, [
      { kind: 'file', text: '*** foo.ts' },
      { kind: 'del', text: '- old' },
      { kind: 'add', text: '+ new' },
    ]);
  });

  it('parses object with file_text', () => {
    const result = parseDiff({ path: 'foo.ts', file_text: 'line1\nline2' });
    assert.ok(result);
    assert.equal(result[0].kind, 'file');
    assert.deepEqual(result.slice(1), [
      { kind: 'add', text: '+ line1' },
      { kind: 'add', text: '+ line2' },
    ]);
  });

  it('parses object with multiline old_str/new_str', () => {
    const result = parseDiff({ old_str: 'a\nb', new_str: 'c\nd' });
    assert.ok(result);
    assert.deepEqual(result, [
      { kind: 'del', text: '- a' },
      { kind: 'del', text: '- b' },
      { kind: 'add', text: '+ c' },
      { kind: 'add', text: '+ d' },
    ]);
  });

  it('returns null for undefined', () => {
    assert.equal(parseDiff(undefined), null);
  });

  it('returns null for string without patch marker', () => {
    assert.equal(parseDiff('just a regular string'), null);
  });

  it('returns null for object with only path', () => {
    assert.equal(parseDiff({ path: 'foo.ts' }), null);
  });
});

// --- normalizeEventsResponse ---

describe('normalizeEventsResponse', () => {
  it('passes through envelope format', () => {
    const body = {
      events: [{ id: 1, session_id: 's1', seq: 1, type: 'user_message', data: '{}', created_at: '2024-01-01' }],
      streaming: { thinking: false, assistant: true },
      total: 10,
      hasMore: true,
    };
    const result = normalizeEventsResponse(body);
    assert.equal(result.events.length, 1);
    assert.equal(result.streaming.assistant, true);
    assert.equal(result.total, 10);
    assert.equal(result.hasMore, true);
  });

  it('wraps legacy array format', () => {
    const body = [
      { id: 1, session_id: 's1', seq: 1, type: 'user_message', data: '{}', created_at: '2024-01-01' },
    ];
    const result = normalizeEventsResponse(body);
    assert.equal(result.events.length, 1);
    assert.equal(result.streaming.thinking, false);
    assert.equal(result.streaming.assistant, false);
    assert.equal(result.hasMore, undefined);
  });

  it('filters non-number total and non-boolean hasMore', () => {
    const body = { events: [], streaming: { thinking: false, assistant: false }, total: '10', hasMore: null };
    const result = normalizeEventsResponse(body);
    assert.equal(result.total, undefined);
    assert.equal(result.hasMore, undefined);
  });
});

// --- isPromptIdle ---

describe('isPromptIdle', () => {
  it('returns true when prompt done and nothing pending', () => {
    assert.equal(isPromptIdle(true, 0, 0), true);
  });

  it('returns false when promptDone is false', () => {
    assert.equal(isPromptIdle(false, 0, 0), false);
  });

  it('returns false when tool calls pending', () => {
    assert.equal(isPromptIdle(true, 2, 0), false);
  });

  it('returns false when permissions pending', () => {
    assert.equal(isPromptIdle(true, 0, 1), false);
  });

  it('returns false when both pending', () => {
    assert.equal(isPromptIdle(true, 1, 1), false);
  });
});
