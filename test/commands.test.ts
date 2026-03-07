import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState, createMockWS } from "./frontend-setup.ts";

describe("commands", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let fetchCalls: string[];

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.js");
    commands = await import("../public/js/commands.js");
  });

  after(() => teardownDOM());
  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    globalThis.fetch = undefined as any;
  });

  function setFetch(handler: (url: string, init?: any) => Promise<any> | any) {
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push(url);
      return handler(url, init);
    }) as any;
  }

  function messageLines() {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  describe("handleSlashCommand", () => {
    it("creates a new session using the provided cwd", async () => {
      const ws = createMockWS();
      state.ws = ws;
      state.sessionId = "current-session";
      state.sessionCwd = "/current";

      const handled = await commands.handleSlashCommand("/new /tmp/project");

      assert.equal(handled, true);
      assert.equal(state.awaitingNewSession, true);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "new_session",
        cwd: "/tmp/project",
        inheritFromSessionId: "current-session",
      });
      assert.ok(messageLines().includes("Creating new session…"));
    });

    it("shows the current working directory for /pwd", async () => {
      state.sessionCwd = "/repo";

      const handled = await commands.handleSlashCommand("/pwd");

      assert.equal(handled, true);
      assert.ok(messageLines().includes("📁 /repo"));
    });

    it("shows help for ? and advertises /help as an alias", async () => {
      const handled = await commands.handleSlashCommand("?");

      assert.equal(handled, true);
      const lines = messageLines();
      assert.ok(lines.includes("? — Show help"));
      assert.ok(lines.includes("/help — Show help (alias)"));
      assert.ok(lines.includes("!<command> — Run bash command"));
      assert.ok(!lines.includes("/help — Show help"));
    });

    it("still accepts /help for backwards compatibility", async () => {
      const handled = await commands.handleSlashCommand("/help");

      assert.equal(handled, true);
      const lines = messageLines();
      assert.ok(lines.includes("? — Show help"));
    });

    it("deletes a matching non-current session", async () => {
      const ws = createMockWS();
      state.ws = ws;
      state.sessionId = "current";
      setFetch(async () => ({
        json: async () => [
          { id: "current", title: "Current Session" },
          { id: "other-123", title: "Other Session" },
        ],
      }));

      const handled = await commands.handleSlashCommand("/delete other");

      assert.equal(handled, true);
      assert.deepEqual(fetchCalls, ["/api/sessions"]);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "delete_session",
        sessionId: "other-123",
      });
      assert.ok(messageLines().includes("Deleted: Other Session"));
    });

    it("prunes every session except the current one", async () => {
      const ws = createMockWS();
      state.ws = ws;
      state.sessionId = "keep";
      setFetch(async () => ({
        json: async () => [
          { id: "keep", title: "Keep" },
          { id: "drop-1", title: "Drop One" },
          { id: "drop-2", title: "Drop Two" },
        ],
      }));

      const handled = await commands.handleSlashCommand("/prune");

      assert.equal(handled, true);
      assert.equal(ws.sent.length, 2);
      assert.deepEqual(ws.sent.map((msg: string) => JSON.parse(msg)), [
        { type: "delete_session", sessionId: "drop-1" },
        { type: "delete_session", sessionId: "drop-2" },
      ]);
      assert.ok(messageLines().includes("Pruned 2 session(s)."));
    });

    it("switches to a matching session and loads history", async () => {
      const ws = createMockWS();
      state.ws = ws;
      state.sessionId = "current";
      setFetch(async (url: string) => {
        if (url === "/api/sessions") {
          return {
            json: async () => [{ id: "target-1", title: "Target Session" }],
          };
        }
        if (url === "/api/sessions/target-1/events") {
          return {
            ok: true,
            json: async () => [{ type: "assistant_message", data: JSON.stringify({ text: "history item" }) }],
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const handled = await commands.handleSlashCommand("/switch target");

      assert.equal(handled, true);
      assert.deepEqual(fetchCalls, ["/api/sessions", "/api/sessions/target-1/events"]);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "resume_session",
        sessionId: "target-1",
      });
      assert.ok(dom.messages.textContent.includes("history item"));
    });

    it("sends cancel when /cancel is used while busy", async () => {
      const ws = createMockWS();
      state.ws = ws;
      state.sessionId = "s1";
      state.busy = true;

      const handled = await commands.handleSlashCommand("/cancel");

      assert.equal(handled, true);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "cancel",
        sessionId: "s1",
      });
      assert.ok(messageLines().includes("^C"));
    });

    it("reports the selected config value when no /model arg is given", async () => {
      state.configOptions = [{
        id: "model",
        name: "Model",
        currentValue: "claude-sonnet-4.6",
        options: [
          { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        ],
      }];

      const handled = await commands.handleSlashCommand("/model");

      assert.equal(handled, true);
      assert.ok(messageLines().includes("Model: Claude Sonnet 4.6"));
      assert.ok(messageLines().includes("Type /model + space to pick from list"));
    });

    it("switches config options using fuzzy matching", async () => {
      const ws = createMockWS();
      state.ws = ws;
      state.sessionId = "s1";
      state.configOptions = [{
        id: "model",
        name: "Model",
        currentValue: "claude-haiku-4.5",
        options: [
          { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        ],
      }];

      const handled = await commands.handleSlashCommand("/model sonnet");

      assert.equal(handled, true);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "set_config_option",
        sessionId: "s1",
        configId: "model",
        value: "claude-sonnet-4.6",
      });
      assert.ok(messageLines().includes("Model → Claude Sonnet 4.6"));
    });

    it("reports ambiguous config matches without sending an update", async () => {
      const ws = createMockWS();
      state.ws = ws;
      state.sessionId = "s1";
      state.configOptions = [{
        id: "model",
        name: "Model",
        currentValue: "claude-haiku-4.5",
        options: [
          { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        ],
      }];

      const handled = await commands.handleSlashCommand("/model sonnet");

      assert.equal(handled, true);
      assert.equal(ws.sent.length, 0);
      assert.ok(messageLines().includes('err: Ambiguous "sonnet". Type /model + space to see options.'));
    });
  });
});
