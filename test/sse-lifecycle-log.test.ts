import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { SseManager } from "../src/sse-manager.ts";
import { setLogLevel, setLogSink, getLogLevel } from "../src/log.ts";

/**
 * SSE lifecycle had no logging at all, which is why a transport-level fault
 * could only be diagnosed by reading source. These lock in the minimum an
 * operator needs: that a client attached, that it went away, and why.
 */
describe("sse lifecycle logging", () => {
  let lines: string[];
  let previousLevel: string;

  function fakeRes(): ServerResponse {
    const handlers = new Map<string, () => void>();
    return {
      writableEnded: false,
      write: () => true,
      end: () => {},
      on: (event: string, cb: () => void) => {
        handlers.set(event, cb);
      },
      emit: (event: string) => handlers.get(event)?.(),
    } as unknown as ServerResponse;
  }

  beforeEach(() => {
    lines = [];
    previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => {
      lines.push(line);
    });
  });

  afterEach(() => {
    setLogSink(null);
    setLogLevel(previousLevel as "off");
  });

  it("records a connect with the client and session it belongs to", () => {
    const mgr = new SseManager();
    mgr.add({ id: "cl-1", res: fakeRes(), sessionId: "s-9" });

    const line = lines.find((l) => l.includes("connected"));
    assert.ok(line, "connect must be logged");
    assert.ok(line.includes("cl-1"));
    assert.ok(line.includes("s-9"));
  });

  it("distinguishes a write failure from an ordinary disconnect", () => {
    const mgr = new SseManager();
    const res = fakeRes();
    mgr.add({ id: "cl-2", res });
    lines.length = 0;

    // A socket torn down between the writableEnded check and the write.
    (res as unknown as { write: () => boolean }).write = () => {
      throw new Error("EPIPE");
    };
    mgr.sendEvent({ id: "cl-2", res }, {
      type: "prompt_done",
      sessionId: "s-9",
    } as never);

    const line = lines.find((l) => l.includes("disconnected"));
    assert.ok(line, "removal must be logged");
    assert.ok(
      line.includes("write-failed"),
      `reason must be recorded, got: ${line}`,
    );
    assert.equal(mgr.size, 0);
  });

  it("logs an ordinary close with its own reason", () => {
    const mgr = new SseManager();
    const res = fakeRes();
    mgr.add({ id: "cl-3", res });
    lines.length = 0;

    (res as unknown as { emit: (e: string) => void }).emit("close");

    const line = lines.find((l) => l.includes("disconnected"));
    assert.ok(line, "close must be logged");
    assert.ok(line.includes("closed"));
    assert.ok(!line.includes("write-failed"));
  });

  it("does not log a second removal for an already-gone client", () => {
    const mgr = new SseManager();
    mgr.add({ id: "cl-4", res: fakeRes() });
    mgr.remove("cl-4");
    lines.length = 0;

    mgr.remove("cl-4");

    assert.equal(
      lines.filter((l) => l.includes("disconnected")).length,
      0,
      "a duplicate removal must stay silent",
    );
  });
});
