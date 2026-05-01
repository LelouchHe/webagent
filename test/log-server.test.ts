// Tests for backend logger (src/log.ts).
//
// Mirrors the frontend log.test.ts structure. Backend writes to stdout/stderr
// rather than DOM; we capture writes via a module-level sink hook so tests
// don't have to monkey-patch process streams.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("backend log (level-gated)", () => {
  let mod: any;
  let sinkLines: { stream: "out" | "err"; line: string }[] = [];

  before(async () => {
    mod = await import("../src/log.ts");
    mod.setLogSink((stream: "out" | "err", line: string) => {
      sinkLines.push({ stream, line });
    });
  });

  after(() => {
    mod.setLogSink(null);
  });

  beforeEach(() => {
    sinkLines = [];
    mod.setLogLevel("off");
  });

  describe("level=off short-circuits", () => {
    it("emits nothing at any severity", () => {
      assert.equal(mod.getLogLevel(), "off");
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.equal(sinkLines.length, 0);
    });
  });

  describe("level=info", () => {
    beforeEach(() => mod.setLogLevel("info"));

    it("emits info/warn/error but blocks debug", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.equal(sinkLines.length, 3);
      const levels = sinkLines.map((s) => {
        const m = /\b(DEBUG|INFO|WARN|ERROR)\b/.exec(s.line);
        return m ? m[1] : "?";
      });
      assert.deepEqual(levels, ["INFO", "WARN", "ERROR"]);
    });
  });

  describe("level=debug emits all", () => {
    beforeEach(() => mod.setLogLevel("debug"));

    it("emits 4 lines for 4 calls", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.equal(sinkLines.length, 4);
    });
  });

  describe("level=warn", () => {
    beforeEach(() => mod.setLogLevel("warn"));

    it("blocks debug+info, passes warn+error", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.equal(sinkLines.length, 2);
    });
  });

  describe("stream routing", () => {
    beforeEach(() => mod.setLogLevel("debug"));

    it("debug+info -> stdout, warn+error -> stderr", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.deepEqual(
        sinkLines.map((s) => s.stream),
        ["out", "out", "err", "err"],
      );
    });
  });

  describe("output formatting", () => {
    beforeEach(() => mod.setLogLevel("debug"));

    it("contains timestamp HH:MM:SS.mmm + LEVEL + message", () => {
      mod.log.info("hello");
      assert.match(
        sinkLines[0].line,
        /^\d{2}:\d{2}:\d{2}\.\d{3} INFO hello\n?$/,
      );
    });

    it("scope rendered as [scope]", () => {
      mod.log.scope("push").warn("subscribed");
      assert.match(sinkLines[0].line, /\[push\] WARN subscribed/);
    });

    it("nested scope chains with dot separator", () => {
      mod.log.scope("a").scope("b").info("x");
      assert.match(sinkLines[0].line, /\[a\.b\] INFO x/);
    });

    it("structured fields appended as JSON", () => {
      mod.log.info("hello", { k: 1 });
      assert.match(sinkLines[0].line, /hello \{"k":1\}/);
    });

    it("each line ends with a newline", () => {
      mod.log.info("nl");
      assert.ok(sinkLines[0].line.endsWith("\n"));
    });
  });

  describe("safeStringify edge cases", () => {
    beforeEach(() => mod.setLogLevel("debug"));

    it("handles cyclic references", () => {
      const a: any = { name: "a" };
      a.self = a;
      mod.log.info("cycle", { a });
      assert.match(sinkLines[0].line, /Circular/);
    });

    it("serialises Error to name+message+stack", () => {
      const err = new Error("boom");
      mod.log.error("fail", { err });
      assert.match(sinkLines[0].line, /boom/);
    });

    it("truncates oversized fields", () => {
      const big = "x".repeat(10_000);
      mod.log.info("big", { big });
      assert.match(sinkLines[0].line, /truncated/);
    });
  });

  describe("runtime level changes", () => {
    it("setLogLevel applies immediately", () => {
      mod.setLogLevel("off");
      mod.log.info("blocked");
      assert.equal(sinkLines.length, 0);
      mod.setLogLevel("info");
      mod.log.info("passes");
      assert.equal(sinkLines.length, 1);
      mod.setLogLevel("off");
      mod.log.info("blocked again");
      assert.equal(sinkLines.length, 1);
    });

    it("ignores invalid level values", () => {
      mod.setLogLevel("info");
      mod.setLogLevel("loud");
      assert.equal(mod.getLogLevel(), "info");
    });
  });
});
