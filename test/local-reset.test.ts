import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";
import { TOKEN_STORAGE_KEY } from "../public/js/login-core.ts";

describe("local reset", () => {
  let mod: typeof import("../public/js/local-reset.ts");

  before(async () => {
    setupDOM();
    mod = await import("../public/js/local-reset.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("clears WebAgent local state but preserves the auth token", () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, "wat_keep");
    localStorage.setItem("theme", "dark");
    localStorage.setItem("wa_log_level", "debug");
    localStorage.setItem("webagent_notify_tip_shown", "1");
    localStorage.setItem("unrelated", "keep");

    const removed = mod.clearResettableLocalStorage();

    assert.deepEqual(removed.sort(), [
      "theme",
      "wa_log_level",
      "webagent_notify_tip_shown",
    ]);
    assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), "wat_keep");
    assert.equal(localStorage.getItem("unrelated"), "keep");
  });

  it("treats future wa_ and webagent_ keys as resettable except token", () => {
    assert.equal(mod.isResettableLocalStorageKey("wa_future_flag"), true);
    assert.equal(mod.isResettableLocalStorageKey("webagent_future_flag"), true);
    assert.equal(mod.isResettableLocalStorageKey(TOKEN_STORAGE_KEY), false);
    assert.equal(mod.isResettableLocalStorageKey("other_app"), false);
  });
});
