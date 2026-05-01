import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SseManager } from "../src/sse-manager.ts";
import type { SseClient } from "../src/sse-manager.ts";
import type { AgentEvent } from "../src/types.ts";
import { buildLabelMap } from "../src/attachment-labels.ts";

/**
 * Unit-level guard that the SSE egress chokepoint applies attachment
 * label enrichment per CLAUDE.md "Attachment label egress rewrite".
 * We don't need a real server; sendEvent + broadcast write to a fake
 * response object whose accumulated buffer we parse.
 */
function makeFakeClient(id: string, sessionId?: string) {
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    write(s: string) {
      chunks.push(s);
      return true;
    },
    on() {
      /* fake — no real socket events */
    },
  } as unknown as SseClient["res"];
  const client: SseClient = { id, res, sessionId };
  return { client, chunks };
}

function readDataLines(chunks: string[]): unknown[] {
  return chunks
    .join("")
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.replace(/^data: /, "")));
}

describe("SseManager attachment label egress rewrite", () => {
  it("broadcast() rewrites tool_call paths via the label-map provider", () => {
    const sm = new SseManager();
    const map = buildLabelMap([
      {
        id: "abcd1234",
        name: "report.pdf",
        realpath: "/data/uploads/s1/abcd1234.pdf",
      },
    ]);
    sm.setLabelMapProvider(() => map);

    const { client, chunks } = makeFakeClient("c1");
    sm.add(client);

    const ev: AgentEvent = {
      type: "tool_call",
      sessionId: "s1",
      id: "t1",
      title: "Read /data/uploads/s1/abcd1234.pdf",
      kind: "read",
      rawInput: { path: "/data/uploads/s1/abcd1234.pdf" },
    };
    sm.broadcast(ev);

    const events = readDataLines(chunks);
    assert.equal(events.length, 1);
    const out = events[0] as { title: string; rawInput: { path: string } };
    assert.equal(out.title, "Read report.pdf [#abcd]");
    assert.equal(out.rawInput.path, "report.pdf [#abcd]");

    // Original event object must NOT be mutated.
    assert.equal(ev.title, "Read /data/uploads/s1/abcd1234.pdf");
    assert.deepEqual(ev.rawInput, {
      path: "/data/uploads/s1/abcd1234.pdf",
    });
  });

  it("broadcast() does NOT rewrite permission_request.rawInput (F2 safety)", () => {
    const sm = new SseManager();
    const map = buildLabelMap([
      {
        id: "abcd1234",
        name: "report.pdf",
        realpath: "/data/uploads/s1/abcd1234.pdf",
      },
    ]);
    sm.setLabelMapProvider(() => map);

    const { client, chunks } = makeFakeClient("c1");
    sm.add(client);

    sm.broadcast({
      type: "permission_request",
      requestId: "r1",
      sessionId: "s1",
      title: "Allow read /data/uploads/s1/abcd1234.pdf",
      options: [],
      rawInput: { path: "/data/uploads/s1/abcd1234.pdf" },
    });

    const out = readDataLines(chunks)[0] as {
      title: string;
      rawInput: { path: string };
    };
    assert.equal(out.title, "Allow read report.pdf [#abcd]");
    assert.equal(
      out.rawInput.path,
      "/data/uploads/s1/abcd1234.pdf",
      "permission rawInput.path MUST stay raw — F2 interceptor depends on it",
    );
  });

  it("does nothing when no label-map provider is set", () => {
    const sm = new SseManager();
    const { client, chunks } = makeFakeClient("c1");
    sm.add(client);

    sm.broadcast({
      type: "tool_call",
      sessionId: "s1",
      id: "t1",
      title: "Read /any/path.pdf",
      kind: "read",
      rawInput: { path: "/any/path.pdf" },
    });
    const out = readDataLines(chunks)[0] as { title: string };
    assert.equal(out.title, "Read /any/path.pdf");
  });

  it("does nothing when label map for the session is empty", () => {
    const sm = new SseManager();
    sm.setLabelMapProvider(() => new Map());
    const { client, chunks } = makeFakeClient("c1");
    sm.add(client);

    sm.broadcast({
      type: "tool_call",
      sessionId: "s1",
      id: "t1",
      title: "Read /any/path.pdf",
      kind: "read",
    });
    const out = readDataLines(chunks)[0] as { title: string };
    assert.equal(out.title, "Read /any/path.pdf");
  });

  it("looks up label map by event sessionId per-call (no leak across sessions)", () => {
    const sm = new SseManager();
    const m1 = buildLabelMap([
      { id: "1111aaaa", name: "a.txt", realpath: "/r/1.txt" },
    ]);
    const m2 = buildLabelMap([
      { id: "2222bbbb", name: "b.txt", realpath: "/r/2.txt" },
    ]);
    sm.setLabelMapProvider((sid) => (sid === "s1" ? m1 : m2));

    const { client, chunks } = makeFakeClient("c1");
    sm.add(client);

    sm.broadcast({
      type: "tool_call",
      sessionId: "s2",
      id: "t1",
      title: "Read /r/2.txt",
      kind: "read",
    });
    sm.broadcast({
      type: "tool_call",
      sessionId: "s1",
      id: "t2",
      title: "Read /r/1.txt",
      kind: "read",
    });

    const events = readDataLines(chunks) as Array<{ title: string }>;
    assert.equal(events[0].title, "Read b.txt [#2222]");
    assert.equal(events[1].title, "Read a.txt [#1111]");
  });
});
