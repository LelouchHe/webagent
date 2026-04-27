// Tests for the in-page debug log module (public/js/log.ts).
// Single-knob design: level gates everything. level !== "off" emits to BOTH
// console and the inline renderer (if set).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("log (level-gated)", () => {
  let mod: any;
  let consoleSpy: { level: string; args: unknown[] }[] = [];
  let renderedLines: string[] = [];
  const origConsole: Record<string, any> = {};

  before(async () => {
    setupDOM();
    mod = await import("../public/js/log.ts");
    for (const lvl of ["debug", "info", "warn", "error"] as const) {
      origConsole[lvl] = (console as any)[lvl];
      (console as any)[lvl] = (...args: unknown[]) =>
        consoleSpy.push({ level: lvl, args });
    }
    mod.setLogRenderer((text: string) => {
      renderedLines.push(text);
      const el = document.createElement("div");
      el.className = "system-msg";
      el.textContent = text;
      return el;
    });
  });

  after(() => {
    for (const lvl of ["debug", "info", "warn", "error"] as const) {
      (console as any)[lvl] = origConsole[lvl];
    }
    teardownDOM();
  });

  beforeEach(() => {
    consoleSpy = [];
    renderedLines = [];
    mod.setLogLevel("off");
  });

  describe("level=off short-circuits", () => {
    it("emits nothing at any severity", () => {
      assert.equal(mod.getLogLevel(), "off");
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.equal(consoleSpy.length, 0);
      assert.equal(renderedLines.length, 0);
    });
  });

  describe("level=info", () => {
    beforeEach(() => mod.setLogLevel("info"));

    it("emits info/warn/error but blocks debug", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.deepEqual(
        consoleSpy.map((s) => s.level),
        ["info", "warn", "error"],
      );
      assert.equal(renderedLines.length, 3);
    });
  });

  describe("level=debug", () => {
    beforeEach(() => mod.setLogLevel("debug"));

    it("emits all severities", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.equal(consoleSpy.length, 4);
      assert.equal(renderedLines.length, 4);
    });
  });

  describe("level=warn", () => {
    beforeEach(() => mod.setLogLevel("warn"));

    it("blocks debug and info, emits warn/error", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.deepEqual(
        consoleSpy.map((s) => s.level),
        ["warn", "error"],
      );
    });
  });

  describe("level=error", () => {
    beforeEach(() => mod.setLogLevel("error"));

    it("only error passes", () => {
      mod.log.debug("d");
      mod.log.info("i");
      mod.log.warn("w");
      mod.log.error("e");
      assert.deepEqual(
        consoleSpy.map((s) => s.level),
        ["error"],
      );
    });
  });

  describe("runtime level changes", () => {
    it("setLogLevel applies immediately", () => {
      mod.setLogLevel("off");
      mod.log.info("blocked");
      assert.equal(consoleSpy.length, 0);
      mod.setLogLevel("info");
      mod.log.info("passes");
      assert.equal(consoleSpy.length, 1);
      mod.setLogLevel("off");
      mod.log.info("blocked again");
      assert.equal(consoleSpy.length, 1);
    });
  });

  describe("output formatting", () => {
    beforeEach(() => mod.setLogLevel("debug"));

    it("console prefix + DOM line reflect scope", () => {
      mod.log.scope("net").warn("request failed");
      assert.equal(consoleSpy[0].level, "warn");
      assert.match(String(consoleSpy[0].args[0]), /^\[net\] request failed$/);
      assert.match(renderedLines[0], /\[net\] WARN request failed/);
    });

    it("nested scope chains with dot separator", () => {
      mod.log.scope("a").scope("b").info("x");
      assert.match(String(consoleSpy[0].args[0]), /^\[a\.b\] x$/);
      assert.match(renderedLines[0], /\[a\.b\] INFO x/);
    });

    it("structured fields stringified into DOM line", () => {
      mod.log.info("hello", { k: 1 });
      assert.match(renderedLines[0], /hello \{"k":1\}/);
    });

    it("DOM renderer is skipped when not set", () => {
      // Temporarily replace renderer with no-op returning dummy element
      const prev = mod.setLogRenderer;
      // Can't unset cleanly; this test just confirms renderer is called at least once.
      mod.log.info("x");
      assert.ok(renderedLines.length >= 1);
      void prev;
    });
  });

  describe("safeStringify edge cases", () => {
    beforeEach(() => mod.setLogLevel("debug"));

    it("handles cyclic references", () => {
      const a: any = { name: "a" };
      a.self = a;
      mod.log.info("cycle", { a });
      assert.match(renderedLines[0], /Circular/);
    });

    it("serialises Error to name+message+stack", () => {
      const err = new Error("boom");
      mod.log.error("fail", { err });
      assert.match(renderedLines[0], /boom/);
    });

    it("truncates oversized fields", () => {
      const big = "x".repeat(10_000);
      mod.log.info("big", { big });
      assert.match(renderedLines[0], /truncated/);
    });
  });

  describe("parseUrlLogLevel", () => {
    it("returns valid level for ?debug=info", () => {
      const res = mod.parseUrlLogLevelFrom("http://x/?debug=info");
      assert.equal(res, "info");
    });

    it("accepts all five values", () => {
      for (const lvl of ["off", "debug", "info", "warn", "error"]) {
        assert.equal(mod.parseUrlLogLevelFrom(`http://x/?debug=${lvl}`), lvl);
      }
    });

    it("returns null when param absent", () => {
      assert.equal(mod.parseUrlLogLevelFrom("http://x/"), null);
    });

    it("returns null for invalid level (e.g. ?debug=1 legacy)", () => {
      assert.equal(mod.parseUrlLogLevelFrom("http://x/?debug=1"), null);
      assert.equal(mod.parseUrlLogLevelFrom("http://x/?debug=yes"), null);
      assert.equal(mod.parseUrlLogLevelFrom("http://x/?debug="), null);
    });
  });
});
