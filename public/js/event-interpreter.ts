// Pure data transformation functions for ACP event interpretation.
// ZERO DOM DEPENDENCY — this module must work in pure Node.js without jsdom/happy-dom.

import { TOOL_ICONS, DEFAULT_TOOL_ICON, PLAN_STATUS_ICONS } from './constants.ts';
import type {
  RawInput, PlanEntry, StoredEvent,
  ToolCallView, StatusIconResult, PermissionClassification,
  DiffLine, PlanEntryView, ToolContentItem, NormalizedEventsResponse,
} from '../../src/types.ts';

/** Interpret a tool_call event into a display-ready view model. */
export function interpretToolCall(kind: string, title: string, rawInput?: RawInput): ToolCallView {
  const icon = TOOL_ICONS[kind] || DEFAULT_TOOL_ICON;
  let detail: string | undefined;
  let detailPrefix: string | undefined;

  if (rawInput && typeof rawInput === 'object') {
    if (rawInput.command) {
      detail = rawInput.command;
      detailPrefix = '$ ';
    } else if (rawInput.path) {
      detail = rawInput.path;
    }
  }

  return { icon, title, detail, detailPrefix, showDiff: kind === 'edit' };
}

/** Extract display text from a tool_call_update content array. */
export function extractToolCallContent(content: ToolContentItem[]): string {
  return content
    .map(c => {
      if (c.type === 'terminal') return `[terminal ${c.terminalId}]`;
      if (c.content && !Array.isArray(c.content) && c.content.text) return c.content.text;
      if (Array.isArray(c.content)) return c.content.map(cc => cc.text || '').join('');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Map a tool_call_update status to display icon and CSS class. */
export function getStatusIcon(status: string): StatusIconResult {
  const icon = status === 'completed' ? '✓' : status === 'failed' ? '✗' : '…';
  return { icon, className: `tool-call ${status}` };
}

/**
 * Classify a permission option kind into CSS class and API action.
 * These are two independent checks — not a simple binary:
 * - cssClass: 'allow' if kind contains 'allow', else 'deny'
 * - apiAction: 'deny' if kind contains 'reject' or 'deny', else 'resolve'
 */
export function classifyPermissionOption(kind: string): PermissionClassification {
  const k = kind || '';
  const cssClass = k.includes('allow') ? 'allow' as const : 'deny' as const;
  const apiAction = (k.includes('reject') || k.includes('deny')) ? 'deny' as const : 'resolve' as const;
  return { cssClass, apiAction };
}

/** Derive the display label for a resolved permission. */
export function resolvePermissionLabel(optionName?: string, denied?: boolean): string {
  return optionName || (denied ? 'denied' : 'allowed');
}

/** Map plan entries to display-ready view models with status symbols. */
export function formatPlanEntries(entries: PlanEntry[]): PlanEntryView[] {
  return entries.map(e => ({
    symbol: PLAN_STATUS_ICONS[e.status] || '?',
    content: e.content,
  }));
}

/**
 * Parse a rawInput into structured diff lines (no HTML, no escaping).
 * Returns null if the input doesn't represent a diff.
 */
export function parseDiff(rawInput: RawInput | undefined): DiffLine[] | null {
  // Case 1: patch string format (*** Begin Patch)
  if (typeof rawInput === 'string' && rawInput.includes('*** Begin Patch')) {
    const lines = rawInput.split('\n');
    const result: DiffLine[] = [];
    for (const line of lines) {
      if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) continue;
      if (line.startsWith('*** Update File:') || line.startsWith('*** Add File:') || line.startsWith('*** Delete File:')) {
        result.push({ kind: 'file', text: line });
      } else if (line.startsWith('@@')) {
        result.push({ kind: 'hunk', text: line });
      } else if (line.startsWith('-')) {
        result.push({ kind: 'del', text: line });
      } else if (line.startsWith('+')) {
        result.push({ kind: 'add', text: line });
      } else {
        result.push({ kind: 'context', text: line });
      }
    }
    return result;
  }

  // Case 2: object with old_str / new_str / file_text
  if (rawInput && typeof rawInput === 'object') {
    const result: DiffLine[] = [];
    if (rawInput.path) result.push({ kind: 'file', text: `*** ${rawInput.path}` });
    if (rawInput.old_str != null) {
      for (const line of String(rawInput.old_str).split('\n')) {
        result.push({ kind: 'del', text: `- ${line}` });
      }
    }
    if (rawInput.new_str != null) {
      for (const line of String(rawInput.new_str).split('\n')) {
        result.push({ kind: 'add', text: `+ ${line}` });
      }
    }
    if (rawInput.file_text != null) {
      for (const line of String(rawInput.file_text).split('\n')) {
        result.push({ kind: 'add', text: `+ ${line}` });
      }
    }
    // Only path with no content → null
    return result.length > (rawInput.path ? 1 : 0) ? result : null;
  }

  return null;
}

/** Normalize events API response: supports both envelope and legacy array formats. */
export function normalizeEventsResponse(body: unknown): NormalizedEventsResponse {
  if (Array.isArray(body)) {
    return { events: body as StoredEvent[], streaming: { thinking: false, assistant: false } };
  }
  const envelope = body as Record<string, unknown>;
  return {
    events: (envelope.events || []) as StoredEvent[],
    streaming: (envelope.streaming || { thinking: false, assistant: false }) as { thinking: boolean; assistant: boolean },
    total: typeof envelope.total === 'number' ? envelope.total : undefined,
    hasMore: typeof envelope.hasMore === 'boolean' ? envelope.hasMore : undefined,
  };
}

/** Check if prompt is idle (done and no pending tool calls or permissions). */
export function isPromptIdle(pendingPromptDone: boolean, pendingToolCallCount: number, pendingPermissionCount: number): boolean {
  return pendingPromptDone && pendingToolCallCount === 0 && pendingPermissionCount === 0;
}
