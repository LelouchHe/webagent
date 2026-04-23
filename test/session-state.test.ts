import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { SessionStateManager } from "../src/session-state.ts";
import type { StatePatchEvent } from "../src/session-state.ts";

describe("SessionStateManager", () => {
  let sm: SessionStateManager;

  beforeEach(() => {
    sm = new SessionStateManager();
  });

  describe("getState", () => {
    it("returns default state for unknown session (seq 0, busy null)", () => {
      const s = sm.getState("s1");
      assert.equal(s.seq, 0);
      assert.equal(s.runtime.busy, null);
    });

    it("returns same object across calls until patched", () => {
      const a = sm.getState("s1");
      const b = sm.getState("s1");
      assert.equal(a.seq, b.seq);
    });
  });

  describe("patch", () => {
    it("bumps seq on each patch", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      assert.equal(sm.getState("s1").seq, 1);
      sm.patch("s1", { runtime: { busy: null } });
      assert.equal(sm.getState("s1").seq, 2);
    });

    it("merges runtime fields (deep)", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      assert.deepEqual(sm.getState("s1").runtime.busy, {
        kind: "agent",
        since: "t0",
        promptId: "p1",
      });
      sm.patch("s1", { runtime: { busy: null } });
      assert.equal(sm.getState("s1").runtime.busy, null);
    });

    it("isolates state per session", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      assert.equal(sm.getState("s2").runtime.busy, null);
      assert.notEqual(sm.getState("s1").seq, sm.getState("s2").seq);
    });

    it("skips broadcast when patch is a no-op", () => {
      const events: StatePatchEvent[] = [];
      sm.onPatch((e) => events.push(e));
      // initial busy is null; patching to null again is a no-op
      sm.patch("s1", { runtime: { busy: null } });
      assert.equal(events.length, 0);
      assert.equal(sm.getState("s1").seq, 0);
    });

    it("fires listener with patch event", () => {
      const events: StatePatchEvent[] = [];
      sm.onPatch((e) => events.push(e));
      sm.patch("s1", { runtime: { busy: { kind: "bash", since: "t0", promptId: null } } });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "state_patch");
      assert.equal(events[0].sessionId, "s1");
      assert.equal(events[0].seq, 1);
      assert.deepEqual(events[0].patch.runtime!.busy, {
        kind: "bash",
        since: "t0",
        promptId: null,
      });
    });

    it("multiple subscribers each receive the patch", () => {
      let a = 0,
        b = 0;
      sm.onPatch(() => {
        a++;
      });
      sm.onPatch(() => {
        b++;
      });
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      assert.equal(a, 1);
      assert.equal(b, 1);
    });
  });

  describe("snapshot shape", () => {
    it("returns version + seq + runtime", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      const snap = sm.getState("s1");
      assert.equal(snap.seq, 1);
      assert.ok(snap.runtime);
    });
  });

  describe("delete", () => {
    it("clears state for a session", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      assert.equal(sm.getState("s1").seq, 1);
      sm.delete("s1");
      assert.equal(sm.getState("s1").seq, 0);
      assert.equal(sm.getState("s1").runtime.busy, null);
    });
  });

  describe("cancel safety net", () => {
    beforeEach(() => {
      mock.timers.enable({ apis: ["setTimeout"] });
    });
    afterEach(() => {
      mock.timers.reset();
    });

    it("armCancelSafety clears busy after the timeout elapses", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      sm.armCancelSafety("s1", 20);
      mock.timers.tick(20);
      assert.equal(sm.getState("s1").runtime.busy, null);
    });

    it("does nothing when busy is already cleared before timeout", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      sm.armCancelSafety("s1", 30);
      sm.patch("s1", { runtime: { busy: null } });
      const seqAfterClear = sm.getState("s1").seq;
      mock.timers.tick(50);
      assert.equal(
        sm.getState("s1").seq,
        seqAfterClear,
        "safety net must not bump seq when already clean",
      );
    });

    it("multiple arms on the same session coalesce (no double-clear)", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      sm.armCancelSafety("s1", 20);
      sm.armCancelSafety("s1", 20);
      mock.timers.tick(20);
      // Should only bump seq once for the clear
      assert.equal(sm.getState("s1").seq, 2);
      assert.equal(sm.getState("s1").runtime.busy, null);
    });

    it("is a no-op when timeout <= 0", () => {
      sm.patch("s1", { runtime: { busy: { kind: "agent", since: "t0", promptId: "p1" } } });
      sm.armCancelSafety("s1", 0);
      mock.timers.tick(50);
      assert.notEqual(sm.getState("s1").runtime.busy, null);
    });
  });

  describe("pendingPermissions", () => {
    const p1 = {
      requestId: "r1",
      toolName: "shell",
      title: "Run ls",
      options: [{ optionId: "allow", label: "Allow" }],
    };
    const p2 = {
      requestId: "r2",
      toolName: "fs_read",
      title: "Read file",
      options: [{ optionId: "allow", label: "Allow" }],
    };

    it("is empty by default", () => {
      assert.deepEqual(sm.getState("s1").runtime.pendingPermissions, []);
    });

    it("patch replaces the whole array and bumps seq", () => {
      sm.patch("s1", { runtime: { pendingPermissions: [p1] } });
      assert.equal(sm.getState("s1").seq, 1);
      assert.deepEqual(sm.getState("s1").runtime.pendingPermissions, [p1]);
      sm.patch("s1", { runtime: { pendingPermissions: [p1, p2] } });
      assert.equal(sm.getState("s1").seq, 2);
      assert.deepEqual(sm.getState("s1").runtime.pendingPermissions, [p1, p2]);
    });

    it("is a no-op when array content is unchanged", () => {
      sm.patch("s1", { runtime: { pendingPermissions: [p1] } });
      const seqBefore = sm.getState("s1").seq;
      sm.patch("s1", { runtime: { pendingPermissions: [p1] } });
      assert.equal(sm.getState("s1").seq, seqBefore);
    });

    it("empty array clears and bumps seq once", () => {
      sm.patch("s1", { runtime: { pendingPermissions: [p1] } });
      sm.patch("s1", { runtime: { pendingPermissions: [] } });
      assert.equal(sm.getState("s1").seq, 2);
      assert.deepEqual(sm.getState("s1").runtime.pendingPermissions, []);
    });
  });

  describe("streaming", () => {
    it("defaults to both false", () => {
      assert.deepEqual(sm.getState("s1").runtime.streaming, { assistant: false, thinking: false });
    });

    it("patch partial field merges without clobbering the other", () => {
      sm.patch("s1", { runtime: { streaming: { assistant: true } } });
      assert.deepEqual(sm.getState("s1").runtime.streaming, { assistant: true, thinking: false });
      sm.patch("s1", { runtime: { streaming: { thinking: true } } });
      assert.deepEqual(sm.getState("s1").runtime.streaming, { assistant: true, thinking: true });
    });

    it("no-op when value equals current", () => {
      sm.patch("s1", { runtime: { streaming: { assistant: true } } });
      const seqBefore = sm.getState("s1").seq;
      sm.patch("s1", { runtime: { streaming: { assistant: true } } });
      assert.equal(sm.getState("s1").seq, seqBefore);
    });
  });
});
