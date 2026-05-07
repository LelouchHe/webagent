import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractModeId,
  isPlanMode,
  isAutopilotMode,
  shouldShowModePill,
  formatModeLabel,
} from "../src/mode-bucket.ts";

describe("mode-bucket", () => {
  describe("extractModeId", () => {
    it("returns the segment after # in URL form (Copilot)", () => {
      assert.equal(
        extractModeId(
          "https://agentclientprotocol.com/protocol/session-modes#autopilot",
        ),
        "autopilot",
      );
    });

    it("returns bare string unchanged when no # or / present", () => {
      assert.equal(extractModeId("bypassPermissions"), "bypassPermissions");
      assert.equal(extractModeId("acceptEdits"), "acceptEdits");
      assert.equal(extractModeId("plan"), "plan");
      assert.equal(extractModeId("default"), "default");
    });

    it("handles empty / null / undefined", () => {
      assert.equal(extractModeId(""), "");
      assert.equal(extractModeId(null), "");
      assert.equal(extractModeId(undefined), "");
    });

    it("picks the last segment after # or /", () => {
      assert.equal(extractModeId("a/b/c#plan"), "plan");
      assert.equal(extractModeId("foo/bar"), "bar");
    });
  });

  describe("isPlanMode", () => {
    it("matches both URL and bare forms", () => {
      assert.ok(isPlanMode("https://x/modes#plan"));
      assert.ok(isPlanMode("plan"));
    });

    it("matches Codex read-only hyphenated form", () => {
      assert.ok(isPlanMode("read-only"));
    });

    it("rejects everything else", () => {
      assert.ok(!isPlanMode("autopilot"));
      assert.ok(!isPlanMode("default"));
      assert.ok(!isPlanMode("bypassPermissions"));
      assert.ok(!isPlanMode(""));
    });
  });

  describe("isAutopilotMode", () => {
    it("matches Copilot autopilot URL form", () => {
      assert.ok(
        isAutopilotMode(
          "https://agentclientprotocol.com/protocol/session-modes#autopilot",
        ),
      );
    });

    it("matches Claude bypassPermissions bare form", () => {
      assert.ok(isAutopilotMode("bypassPermissions"));
    });

    it("matches Codex full-access hyphenated form", () => {
      assert.ok(isAutopilotMode("full-access"));
    });

    it("does NOT match Claude acceptEdits / dontAsk / auto", () => {
      // These are agent-internal — webagent should not auto-approve.
      assert.ok(!isAutopilotMode("acceptEdits"));
      assert.ok(!isAutopilotMode("dontAsk"));
      assert.ok(!isAutopilotMode("auto"));
    });

    it("rejects default / agent / plan / empty", () => {
      assert.ok(!isAutopilotMode("default"));
      assert.ok(!isAutopilotMode("agent"));
      assert.ok(!isAutopilotMode("plan"));
      assert.ok(!isAutopilotMode(""));
    });
  });

  describe("shouldShowModePill", () => {
    it("hides for canonical defaults", () => {
      assert.ok(!shouldShowModePill("agent"));
      assert.ok(!shouldShowModePill("default"));
      assert.ok(!shouldShowModePill("https://x/modes#agent"));
    });

    it("hides for empty input", () => {
      assert.ok(!shouldShowModePill(""));
      assert.ok(!shouldShowModePill(null));
    });

    it("shows for plan / autopilot", () => {
      assert.ok(shouldShowModePill("plan"));
      assert.ok(shouldShowModePill("autopilot"));
      assert.ok(shouldShowModePill("bypassPermissions"));
    });

    it("shows for Codex read-only / auto / full-access (none are canonical defaults)", () => {
      // Codex's default is read-only — but it's a meaningful safety state,
      // so we show the pill even though it's the "resting" mode.
      assert.ok(shouldShowModePill("read-only"));
      assert.ok(shouldShowModePill("auto"));
      assert.ok(shouldShowModePill("full-access"));
    });

    it("shows for default-bucket members other than canonical default", () => {
      assert.ok(shouldShowModePill("acceptEdits"));
      assert.ok(shouldShowModePill("dontAsk"));
      assert.ok(shouldShowModePill("auto"));
    });
  });

  describe("formatModeLabel", () => {
    it("splits camelCase with leading space at uppercase letters", () => {
      assert.equal(formatModeLabel("bypassPermissions"), "bypass Permissions");
      assert.equal(formatModeLabel("acceptEdits"), "accept Edits");
      assert.equal(formatModeLabel("dontAsk"), "dont Ask");
    });

    it("leaves single-word ids alone", () => {
      assert.equal(formatModeLabel("plan"), "plan");
      assert.equal(formatModeLabel("autopilot"), "autopilot");
      assert.equal(formatModeLabel("default"), "default");
    });

    it("leaves Codex hyphenated ids alone (CSS uppercase handles them)", () => {
      assert.equal(formatModeLabel("read-only"), "read-only");
      assert.equal(formatModeLabel("full-access"), "full-access");
    });

    it("strips URL prefix before splitting", () => {
      assert.equal(formatModeLabel("https://x/modes#autopilot"), "autopilot");
    });

    it("handles empty input", () => {
      assert.equal(formatModeLabel(""), "");
      assert.equal(formatModeLabel(null), "");
    });
  });
});
