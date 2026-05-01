import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildLabelMap,
  enrichEventForDisplay,
  enrichStoredEventDataForDisplay,
  type LabelMap,
} from "../src/attachment-labels.ts";
import type { AgentEvent } from "../src/types.ts";

describe("buildLabelMap", () => {
  it("emits realpath + basename keys with `<name> [#<id4>]` value", () => {
    const m = buildLabelMap([
      {
        id: "abc12345-aaaa-bbbb-cccc-dddddddddddd",
        name: "report.pdf",
        realpath: "/data/uploads/s1/abc12345-aaaa-bbbb-cccc-dddddddddddd.pdf",
      },
    ]);
    assert.equal(
      m.get("/data/uploads/s1/abc12345-aaaa-bbbb-cccc-dddddddddddd.pdf"),
      "report.pdf [#abc1]",
    );
    assert.equal(
      m.get("abc12345-aaaa-bbbb-cccc-dddddddddddd.pdf"),
      "report.pdf [#abc1]",
    );
  });

  it("returns empty map for empty rows", () => {
    assert.equal(buildLabelMap([]).size, 0);
  });

  it("multiple attachments produce distinct labels", () => {
    const m = buildLabelMap([
      { id: "1111aaaa-x", name: "a.txt", realpath: "/r/1.txt" },
      { id: "2222bbbb-y", name: "b.txt", realpath: "/r/2.txt" },
    ]);
    assert.equal(m.get("/r/1.txt"), "a.txt [#1111]");
    assert.equal(m.get("/r/2.txt"), "b.txt [#2222]");
  });

  it("does not shadow a realpath entry with a same-string basename", () => {
    // Pathological: realpath is "foo.txt" (relative), basename is also
    // "foo.txt". The realpath entry must win.
    const m = buildLabelMap([
      { id: "1111aaaa", name: "first.txt", realpath: "foo.txt" },
    ]);
    assert.equal(m.size, 1);
    assert.equal(m.get("foo.txt"), "first.txt [#1111]");
  });
});

function fixedMap(): LabelMap {
  return buildLabelMap([
    {
      id: "abc12345-1111",
      name: "report.pdf",
      realpath: "/data/uploads/s1/abc12345-1111.pdf",
    },
    {
      id: "def67890-2222",
      name: "notes.md",
      realpath: "/data/uploads/s1/def67890-2222.md",
    },
  ]);
}

describe("enrichEventForDisplay", () => {
  describe("tool_call", () => {
    it("rewrites title containing full realpath", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Read /data/uploads/s1/abc12345-1111.pdf",
        kind: "read",
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      assert.equal(out.type, "tool_call");
      assert.equal(out.title, "Read report.pdf [#abc1]");
    });

    it("rewrites title containing basename only", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "View abc12345-1111.pdf",
        kind: "read",
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "tool_call") throw new Error();
      assert.equal(out.title, "View report.pdf [#abc1]");
    });

    it("title with multiple attachments rewrites all, longer key first", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        // basename "abc12345-1111.pdf" is a substring of the full
        // realpath; longer-first must replace path first so basename
        // doesn't partially mangle it.
        title:
          "Compare /data/uploads/s1/abc12345-1111.pdf and def67890-2222.md",
        kind: "read",
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "tool_call") throw new Error();
      assert.equal(
        out.title,
        "Compare report.pdf [#abc1] and notes.md [#def6]",
      );
    });

    it("replaces rawInput.path on exact match", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Read x",
        kind: "read",
        rawInput: { path: "/data/uploads/s1/abc12345-1111.pdf" },
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "tool_call") throw new Error();
      assert.equal(typeof out.rawInput, "object");
      const ri = out.rawInput as { path: string };
      assert.equal(ri.path, "report.pdf [#abc1]");
    });

    it("leaves rawInput.path unchanged when not in map", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Read x",
        kind: "read",
        rawInput: { path: "/Users/me/project/src/main.ts" },
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "tool_call") throw new Error();
      const ri = out.rawInput as { path: string };
      assert.equal(ri.path, "/Users/me/project/src/main.ts");
    });

    it("rawInput as string passes through (legacy schema)", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Run abc12345-1111.pdf",
        kind: "execute",
        rawInput: "echo /data/uploads/s1/abc12345-1111.pdf",
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "tool_call") throw new Error();
      // Title still rewritten (substring), rawInput string untouched.
      assert.equal(out.title, "Run report.pdf [#abc1]");
      assert.equal(out.rawInput, "echo /data/uploads/s1/abc12345-1111.pdf");
    });

    it("missing rawInput passes through", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Plain title with no path",
        kind: "read",
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      // No mutation needed — same reference.
      assert.equal(out, ev);
    });

    it("returns same reference when nothing matches", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "ls /tmp",
        kind: "execute",
        rawInput: { command: "ls /tmp" },
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      assert.equal(out, ev);
    });
  });

  describe("permission_request", () => {
    it("rewrites title", () => {
      const ev: AgentEvent = {
        type: "permission_request",
        requestId: "r1",
        sessionId: "s1",
        title: "Allow read of /data/uploads/s1/abc12345-1111.pdf",
        options: [],
        rawInput: { path: "/data/uploads/s1/abc12345-1111.pdf" },
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "permission_request") throw new Error();
      assert.equal(out.title, "Allow read of report.pdf [#abc1]");
    });

    it("CRITICAL: never modifies rawInput (F2 interceptor depends on raw path)", () => {
      const original = { path: "/data/uploads/s1/abc12345-1111.pdf" };
      const ev: AgentEvent = {
        type: "permission_request",
        requestId: "r1",
        sessionId: "s1",
        title: "Allow read of /data/uploads/s1/abc12345-1111.pdf",
        options: [],
        rawInput: original,
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "permission_request") throw new Error();
      assert.equal(
        out.rawInput,
        original,
        "rawInput object reference must be preserved",
      );
      assert.equal(
        (out.rawInput as Record<string, unknown>).path,
        "/data/uploads/s1/abc12345-1111.pdf",
      );
    });

    it("does not modify locations[]", () => {
      const locations = [
        { path: "/data/uploads/s1/abc12345-1111.pdf", line: 1 },
      ];
      const ev: AgentEvent = {
        type: "permission_request",
        requestId: "r1",
        sessionId: "s1",
        title: "x",
        options: [],
        locations,
      };
      const out = enrichEventForDisplay(ev, fixedMap());
      if (out.type !== "permission_request") throw new Error();
      assert.equal(out.locations, locations);
    });

    it("returns same reference when title has no match", () => {
      const ev: AgentEvent = {
        type: "permission_request",
        requestId: "r1",
        sessionId: "s1",
        title: "Allow ls /tmp",
        options: [],
      };
      assert.equal(enrichEventForDisplay(ev, fixedMap()), ev);
    });
  });

  describe("pass-through", () => {
    it("user_message is not modified even with attachments", () => {
      const ev: AgentEvent = {
        type: "user_message",
        sessionId: "s1",
        text: "see /data/uploads/s1/abc12345-1111.pdf",
        attachments: [
          {
            kind: "file",
            attachmentId: "abc12345-1111",
            displayName: "report.pdf",
            mimeType: "application/pdf",
          },
        ],
      };
      assert.equal(enrichEventForDisplay(ev, fixedMap()), ev);
    });

    it("message_chunk passes through", () => {
      const ev: AgentEvent = {
        type: "message_chunk",
        sessionId: "s1",
        text: "abc12345-1111.pdf",
      };
      assert.equal(enrichEventForDisplay(ev, fixedMap()), ev);
    });

    it("prompt_done passes through", () => {
      const ev: AgentEvent = {
        type: "prompt_done",
        sessionId: "s1",
        stopReason: "end_turn",
      };
      assert.equal(enrichEventForDisplay(ev, fixedMap()), ev);
    });
  });

  describe("empty map", () => {
    it("returns same reference for any event", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Read /any/path.pdf",
        kind: "read",
        rawInput: { path: "/any/path.pdf" },
      };
      assert.equal(enrichEventForDisplay(ev, new Map()), ev);
    });
  });

  describe("immutability", () => {
    it("does not mutate the input event", () => {
      const ev: AgentEvent = {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Read /data/uploads/s1/abc12345-1111.pdf",
        kind: "read",
        rawInput: { path: "/data/uploads/s1/abc12345-1111.pdf" },
      };
      const before = JSON.stringify(ev);
      enrichEventForDisplay(ev, fixedMap());
      assert.equal(JSON.stringify(ev), before);
    });
  });
});

describe("enrichStoredEventDataForDisplay", () => {
  it("rewrites tool_call data JSON", () => {
    const data = JSON.stringify({
      sessionId: "s1",
      id: "t1",
      title: "Read /data/uploads/s1/abc12345-1111.pdf",
      kind: "read",
      rawInput: { path: "/data/uploads/s1/abc12345-1111.pdf" },
    });
    const out = enrichStoredEventDataForDisplay("tool_call", data, fixedMap());
    const parsed = JSON.parse(out);
    assert.equal(parsed.title, "Read report.pdf [#abc1]");
    assert.equal(parsed.rawInput.path, "report.pdf [#abc1]");
    // No spurious `type` key in stored data.
    assert.ok(!("type" in parsed));
  });

  it("rewrites permission_request title only, not rawInput", () => {
    const data = JSON.stringify({
      requestId: "r1",
      sessionId: "s1",
      title: "Allow read /data/uploads/s1/abc12345-1111.pdf",
      options: [],
      rawInput: { path: "/data/uploads/s1/abc12345-1111.pdf" },
    });
    const out = enrichStoredEventDataForDisplay(
      "permission_request",
      data,
      fixedMap(),
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.title, "Allow read report.pdf [#abc1]");
    assert.equal(
      parsed.rawInput.path,
      "/data/uploads/s1/abc12345-1111.pdf",
      "permission rawInput must NOT be rewritten",
    );
  });

  it("returns original string when nothing matches", () => {
    const data = JSON.stringify({
      sessionId: "s1",
      id: "t1",
      title: "ls /tmp",
      kind: "execute",
    });
    assert.equal(
      enrichStoredEventDataForDisplay("tool_call", data, fixedMap()),
      data,
    );
  });

  it("passes through non-target event types", () => {
    const data = JSON.stringify({ text: "abc12345-1111.pdf" });
    assert.equal(
      enrichStoredEventDataForDisplay("user_message", data, fixedMap()),
      data,
    );
    assert.equal(
      enrichStoredEventDataForDisplay("message_chunk", data, fixedMap()),
      data,
    );
  });

  it("returns input unchanged when map is empty", () => {
    const data = JSON.stringify({
      sessionId: "s1",
      id: "t1",
      title: "Read /data/uploads/s1/abc12345-1111.pdf",
      kind: "read",
    });
    assert.equal(
      enrichStoredEventDataForDisplay("tool_call", data, new Map()),
      data,
    );
  });

  it("tolerates malformed JSON (returns original)", () => {
    assert.equal(
      enrichStoredEventDataForDisplay("tool_call", "not-json", fixedMap()),
      "not-json",
    );
  });
});
