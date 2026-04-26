import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePath,
  buildCandidates,
  type CmdNode,
} from "../public/js/slash-tree.ts";

// Build a representative tree for tests (mirrors the planned production tree
// in shape but uses simple stubs for fetch/toSpec).
function makeRoot(): CmdNode {
  return {
    name: '<root>',
    children: [
      { name: '/help', desc: 'Show help', onSelect: async () => {} },
      { name: '/cancel', desc: 'Cancel response', onSelect: async () => {} },
      {
        name: '/notify',
        desc: 'Toggle notifications',
        children: [
          { name: 'on', desc: 'Enable', onSelect: async () => {} },
          { name: 'off', desc: 'Disable', onSelect: async () => {} },
        ],
      },
      {
        name: '/inbox',
        desc: 'Manage inbox',
        fetch: async () => [],
        toSpec: (it: any) => ({ primary: it.id, path: it.cwd }),
        children: [
          {
            name: 'dismiss',
            desc: 'Dismiss only',
            fetch: async () => [],
            toSpec: (it: any) => ({ primary: it.id, path: it.cwd }),
          },
        ],
      },
      {
        name: '/token',
        desc: 'Manage tokens',
        fetch: async () => [],
        toSpec: (it: any) => ({ primary: it.name }),
        freeform: (q) => /^[A-Za-z0-9_-]{1,64}$/.test(q.trim())
          ? { primary: `create token '${q.trim()}'`, onSelect: async () => {} }
          : null,
      },
      {
        name: '/rename',
        desc: 'Rename session',
        freeform: (q) => q.trim()
          ? { primary: `rename to '${q.trim()}'`, onSelect: async () => {} }
          : null,
      },
    ],
  };
}

describe("slash-tree — resolvePath", () => {
  it("empty input → root", () => {
    const root = makeRoot();
    const r = resolvePath('', root);
    assert.equal(r.node, root);
    assert.equal(r.pathPrefix, '');
    assert.equal(r.tailQuery, '');
  });

  it("just slash → root, tailQuery='/'", () => {
    const root = makeRoot();
    const r = resolvePath('/', root);
    assert.equal(r.node, root);
    assert.equal(r.tailQuery, '/');
  });

  it("partial top-level → root, tail is the partial", () => {
    const root = makeRoot();
    const r = resolvePath('/inb', root);
    assert.equal(r.node, root);
    assert.equal(r.tailQuery, '/inb');
  });

  it("exact top-level no trailing space → still at root (filter mode)", () => {
    const root = makeRoot();
    const r = resolvePath('/inbox', root);
    // Today's UX: typing /inbox without space stays at root and fuzzy-matches.
    // To descend, user types /inbox<space>.
    assert.equal(r.node, root);
    assert.equal(r.tailQuery, '/inbox');
  });

  it("top-level with trailing space → descend", () => {
    const root = makeRoot();
    const r = resolvePath('/inbox ', root);
    assert.equal(r.node.name, '/inbox');
    assert.equal(r.pathPrefix, '/inbox');
    assert.equal(r.tailQuery, '');
  });

  it("top-level with query → descend, tailQuery preserved", () => {
    const root = makeRoot();
    const r = resolvePath('/inbox abc', root);
    assert.equal(r.node.name, '/inbox');
    assert.equal(r.pathPrefix, '/inbox');
    assert.equal(r.tailQuery, 'abc');
  });

  it("two-level descend with trailing space", () => {
    const root = makeRoot();
    const r = resolvePath('/inbox dismiss ', root);
    assert.equal(r.node.name, 'dismiss');
    assert.equal(r.pathPrefix, '/inbox dismiss');
    assert.equal(r.tailQuery, '');
  });

  it("two-level descend with query", () => {
    const root = makeRoot();
    const r = resolvePath('/inbox dismiss abc', root);
    assert.equal(r.node.name, 'dismiss');
    assert.equal(r.pathPrefix, '/inbox dismiss');
    assert.equal(r.tailQuery, 'abc');
  });

  it("degrade: unknown sub-token → stay at parent, tailQuery is unknown token", () => {
    const root = makeRoot();
    const r = resolvePath('/inbox xyz ', root);
    assert.equal(r.node.name, '/inbox');
    assert.equal(r.tailQuery, 'xyz');
  });

  it("degrade: unknown second-level sub-token preserves position", () => {
    const root = makeRoot();
    const r = resolvePath('/inbox dismiss stuff and more', root);
    // We descended to dismiss, and 'stuff and more' is the tail
    assert.equal(r.node.name, 'dismiss');
    assert.equal(r.tailQuery, 'stuff and more');
  });
});

describe("slash-tree — buildCandidates", () => {
  it("root + no query → all top-level commands", () => {
    const root = makeRoot();
    const c = buildCandidates(root, '');
    // 6 children, all subcommand kind
    assert.equal(c.length, 6);
    assert.equal(c[0].kind, 'subcommand');
  });

  it("subcommand prefix = '›' for nodes with structure", () => {
    const root = makeRoot();
    const c = buildCandidates(root, '');
    const inbox = c.find(x => x.spec.primary === '/inbox');
    assert.ok(inbox);
    assert.equal(inbox?.prefix, '›');
  });

  it("subcommand prefix = '' for pure leaves (only onSelect)", () => {
    const root = makeRoot();
    const c = buildCandidates(root, '');
    const help = c.find(x => x.spec.primary === '/help');
    assert.equal(help?.prefix, '');
  });

  it("fuzzy match on subcommand name", () => {
    const root = makeRoot();
    const c = buildCandidates(root, '/inb');
    // Should include /inbox but not /help
    const names = c.map(x => x.spec.primary);
    assert.ok(names.includes('/inbox'));
    assert.equal(names.includes('/help'), false);
  });

  it("data items rendered with prefix '' (empty) for non-current", () => {
    const inbox: CmdNode = {
      name: '/inbox',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.id }),
    };
    const c = buildCandidates(inbox, '', [{ id: 'msg1' }, { id: 'msg2' }]);
    assert.equal(c.length, 2);
    assert.equal(c[0].kind, 'data');
    assert.equal(c[0].prefix, '');
    assert.equal(c[0].spec.primary, 'msg1');
  });

  it("data items with current=true get prefix '*'", () => {
    const node: CmdNode = {
      name: '/model',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.name, current: it.cur }),
    };
    const c = buildCandidates(node, '', [
      { name: 'gpt-5', cur: false },
      { name: 'haiku', cur: true },
    ]);
    assert.equal(c[0].prefix, '');
    assert.equal(c[1].prefix, '*');
  });

  it("placeholder (loading)", () => {
    const inbox: CmdNode = {
      name: '/inbox',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.id }),
    };
    const c = buildCandidates(inbox, '', 'loading');
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'placeholder');
    assert.equal(c[0].spec.primary, '(loading...)');
  });

  it("placeholder (error)", () => {
    const inbox: CmdNode = {
      name: '/inbox',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.id }),
    };
    const c = buildCandidates(inbox, '', 'error');
    assert.equal(c.length, 1);
    assert.equal(c[0].spec.primary, '(error)');
  });

  it("placeholder (none) when fetch returns empty array", () => {
    const inbox: CmdNode = {
      name: '/inbox',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.id }),
    };
    const c = buildCandidates(inbox, '', []);
    assert.equal(c.length, 1);
    assert.equal(c[0].spec.primary, '(none)');
  });

  it("placeholder (no match) when fuzzy filter excludes all", () => {
    const inbox: CmdNode = {
      name: '/inbox',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.id }),
    };
    const c = buildCandidates(inbox, 'zzzz', [{ id: 'msg1' }]);
    assert.equal(c.length, 1);
    assert.equal(c[0].spec.primary, '(no match)');
  });

  it("freeform appended after subcommands, before data, with prefix '›'", () => {
    const token: CmdNode = {
      name: '/token',
      children: [{ name: 'rev', desc: 'Revoke', onSelect: async () => {} }],
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.name }),
      freeform: (q) => q ? { primary: `create '${q}'`, onSelect: async () => {} } : null,
    };
    const c = buildCandidates(token, 're', [{ name: 'existing' }]);
    // 're' matches 'rev' (subcommand) AND triggers freeform (regex)
    // data 'existing' does not match 're' → no-match placeholder, no collision
    const kinds = c.map(x => x.kind);
    const subIdx = kinds.indexOf('subcommand');
    const ffIdx = kinds.indexOf('freeform');
    assert.ok(subIdx >= 0 && ffIdx >= 0);
    assert.ok(subIdx < ffIdx, 'subcommand precedes freeform');
    const ffCand = c[ffIdx];
    assert.equal(ffCand.prefix, '›');
    assert.match(ffCand.spec.primary, /create 're'/);
  });

  it("collision: freeform suppressed when query matches an existing data primary", () => {
    const token: CmdNode = {
      name: '/token',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.name }),
      freeform: (q) => q.trim() ? { primary: `create '${q.trim()}'`, onSelect: async () => {} } : null,
    };
    // Query 'mybot' EXACTLY matches existing token name 'mybot'
    const c = buildCandidates(token, 'mybot', [
      { name: 'mybot' },
      { name: 'other' },
    ]);
    const kinds = c.map(x => x.kind);
    assert.equal(kinds.includes('freeform'), false, 'freeform suppressed by collision');
    // And the existing 'mybot' data row IS shown (only one matches by fuzzy)
    assert.ok(c.some(x => x.kind === 'data' && x.spec.primary === 'mybot'));
  });

  it("collision is exact match only — fuzzy query still shows freeform", () => {
    const token: CmdNode = {
      name: '/token',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.name }),
      freeform: (q) => q.trim() ? { primary: `create '${q.trim()}'`, onSelect: async () => {} } : null,
    };
    // 'myb' is a substring fuzzy match of 'mybot' but not exact
    const c = buildCandidates(token, 'myb', [{ name: 'mybot' }]);
    assert.ok(c.some(x => x.kind === 'freeform'));
  });

  it("collision check is case-insensitive", () => {
    const token: CmdNode = {
      name: '/token',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.name }),
      freeform: (q) => q.trim() ? { primary: `create '${q.trim()}'`, onSelect: async () => {} } : null,
    };
    // User types 'MyBot' but data has 'mybot' — should still suppress freeform
    const c = buildCandidates(token, 'MyBot', [{ name: 'mybot' }]);
    assert.equal(c.find(x => x.kind === 'freeform'), undefined);
  });

  it("separator inserted between › group and data when both present", () => {
    const inbox: CmdNode = {
      name: '/inbox',
      children: [{ name: 'dismiss', desc: 'Ack', onSelect: async () => {} }],
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.id }),
    };
    const c = buildCandidates(inbox, '', [{ id: 'msg1' }]);
    const kinds = c.map(x => x.kind);
    const sepIdx = kinds.indexOf('separator');
    const dataIdx = kinds.indexOf('data');
    const subIdx = kinds.indexOf('subcommand');
    assert.ok(sepIdx > subIdx && sepIdx < dataIdx);
  });

  it("no separator when no › group", () => {
    const inbox: CmdNode = {
      name: '/inbox',
      fetch: async () => [],
      toSpec: (it: any) => ({ primary: it.id }),
    };
    const c = buildCandidates(inbox, '', [{ id: 'msg1' }]);
    assert.equal(c.find(x => x.kind === 'separator'), undefined);
  });

  it("no separator when › group exists but data section doesn't (no fetch)", () => {
    const notify: CmdNode = {
      name: '/notify',
      children: [
        { name: 'on', desc: 'Enable', onSelect: async () => {} },
        { name: 'off', desc: 'Disable', onSelect: async () => {} },
      ],
    };
    const c = buildCandidates(notify, '');
    assert.equal(c.find(x => x.kind === 'separator'), undefined);
  });

  it("rename: pure freeform, no fetch → no placeholder, no separator", () => {
    const root = makeRoot();
    const rename = root.children!.find(c => c.name === '/rename')!;
    const c = buildCandidates(rename, 'newtitle');
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'freeform');
  });
});
