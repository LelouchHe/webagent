import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("commands", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
  });

  after(() => teardownDOM());
  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    globalThis.fetch = undefined as any;
  });

  function setFetch(handler: (url: string, init?: any) => Promise<any> | any) {
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return handler(url, init);
    }) as any;
  }

  function messageLines() {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  describe("handleSlashCommand", () => {
    it("creates a new session using the provided cwd", async () => {
      setFetch(() => ({ ok: true, json: async () => ({ id: "new-1" }), text: async () => '{"id":"new-1"}' }));
      state.sessionId = "current-session";
      state.sessionCwd = "/current";

      const handled = await commands.handleSlashCommand("/new /tmp/project");
      await new Promise(r => setTimeout(r, 0)); // flush microtask (fire-and-forget)

      assert.equal(handled, true);
      assert.equal(state.awaitingNewSession, true);
      // requestNewSession now uses REST POST /api/v1/sessions
      const createCall = fetchCalls.find(c => c.url === "/api/v1/sessions" && c.init?.method === "POST");
      assert.ok(createCall, "expected POST /api/v1/sessions");
      const body = JSON.parse(createCall!.init.body);
      assert.equal(body.cwd, "/tmp/project");
      assert.equal(body.inheritFromSessionId, "current-session");
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

    it("shows version line when versions are available", async () => {
      state.serverVersion = "0.1.10";
      state.agentName = "Copilot CLI";
      state.agentVersion = "1.0.5";
      await commands.handleSlashCommand("?");
      const lines = messageLines();
      assert.ok(lines.includes("WebAgent 0.1.10 · Copilot CLI 1.0.5"));
    });

    it("omits version line when no versions are set", async () => {
      await commands.handleSlashCommand("?");
      const lines = messageLines();
      assert.ok(!lines.some(l => l.includes("WebAgent")));
    });

    it("still accepts /help for backwards compatibility", async () => {
      const handled = await commands.handleSlashCommand("/help");

      assert.equal(handled, true);
      const lines = messageLines();
      assert.ok(lines.includes("? — Show help"));
    });

    it("exits current session — deletes it and switches to MRU", async () => {
      state.clientId = "cl-1";
      state.sessionId = "current";
      const configOptions = [{ type: "select", id: "model", name: "Model", currentValue: "gpt-4", options: [] }];
      const sessionList = [
        { id: "current", title: "Current Session" },
        { id: "mru-456", title: "MRU Session" },
      ];
      const mruDetail = { id: "mru-456", cwd: "/home", title: "MRU Session", configOptions, busyKind: null };
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return { ok: true, status: 200, json: async () => data, text: async () => json };
        };
        if (url === "/api/v1/sessions" && (!init?.method || init.method === "GET")) return body(sessionList);
        if (url === "/api/v1/sessions/current" && init?.method === "DELETE") return body({});
        if (url === "/api/v1/sessions/mru-456") return body(mruDetail);
        if (url.includes("/api/v1/sessions/mru-456/events")) return body([]);
        return body({});
      });

      const handled = await commands.handleSlashCommand("/exit");

      assert.equal(handled, true);
      const deleteCall = fetchCalls.find(c => c.url === "/api/v1/sessions/current" && c.init?.method === "DELETE");
      assert.ok(deleteCall, "expected DELETE for current session");
      assert.equal(state.sessionId, "mru-456");
    });

    it("exits last session — deletes it and creates a new one", async () => {
      state.clientId = "cl-1";
      state.sessionId = "only-one";
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return { ok: true, status: 200, json: async () => data, text: async () => json };
        };
        if (url === "/api/v1/sessions" && (!init?.method || init.method === "GET")) {
          return body([{ id: "only-one", title: "Only Session" }]);
        }
        if (url === "/api/v1/sessions/only-one" && init?.method === "DELETE") return body({});
        if (url === "/api/v1/sessions" && init?.method === "POST") return body({ id: "new-1" });
        return body({});
      });

      const handled = await commands.handleSlashCommand("/exit");

      assert.equal(handled, true);
      const deleteCall = fetchCalls.find(c => c.url === "/api/v1/sessions/only-one" && c.init?.method === "DELETE");
      assert.ok(deleteCall, "expected DELETE for the only session");
      assert.equal(state.awaitingNewSession, true);
    });

    it("prunes every session except the current one", async () => {
      state.clientId = "cl-1";
      state.sessionId = "keep";
      setFetch(async (url: string, init?: any) => {
        if (url === "/api/v1/sessions" && (!init || init.method !== "DELETE")) {
          return {
            json: async () => [
              { id: "keep", title: "Keep" },
              { id: "drop-1", title: "Drop One" },
              { id: "drop-2", title: "Drop Two" },
            ],
          };
        }
        // DELETE calls
        return { ok: true, json: async () => ({}) };
      });

      const handled = await commands.handleSlashCommand("/prune");

      assert.equal(handled, true);
      const deleteCalls = fetchCalls.filter(c => c.init?.method === "DELETE");
      assert.equal(deleteCalls.length, 2);
      assert.deepEqual(deleteCalls.map(c => c.url).sort(), [
        "/api/v1/sessions/drop-1",
        "/api/v1/sessions/drop-2",
      ]);
      assert.ok(messageLines().includes("Pruned 2 session(s)."));
    });

    it("switches to a matching session and loads history", async () => {
      state.clientId = "cl-1";
      state.sessionId = "current";
      const configOptions = [{ type: "select", id: "model", name: "Model", currentValue: "gpt-4", options: [] }];
      setFetch(async (url: string) => {
        if (url === "/api/v1/sessions") {
          return {
            json: async () => [{ id: "target-1", title: "Target Session" }],
          };
        }
        if (url.startsWith("/api/v1/sessions/target-1/events")) {
          return {
            ok: true,
            json: async () => [{ type: "assistant_message", data: JSON.stringify({ text: "history item" }) }],
          };
        }
        if (url === "/api/v1/sessions/target-1") {
          const data = { id: "target-1", cwd: "/home/user", title: "Target Session", configOptions, busyKind: null };
          return {
            ok: true,
            json: async () => data,
            text: async () => JSON.stringify(data),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const handled = await commands.handleSlashCommand("/switch target");

      assert.equal(handled, true);
      assert.ok(fetchCalls.some(c => c.url === "/api/v1/sessions"), "should list sessions");
      assert.ok(fetchCalls.some(c => c.url.startsWith("/api/v1/sessions/target-1/events")), "should load events");
      assert.ok(fetchCalls.some(c => c.url === "/api/v1/sessions/target-1" && (!c.init || !c.init.method || c.init.method === "GET")), "should GET session to trigger auto-resume");
      assert.equal(state.sessionId, "target-1");
      assert.equal(state.sessionTitle, "Target Session");
      assert.equal(globalThis.location.hash, "#target-1");
      assert.equal(dom.sessionInfo.textContent, "Target Session");
      assert.ok(dom.messages.textContent.includes("history item"));
      // Status bar should show model and cwd after switch
      assert.ok(dom.statusBar.textContent.includes("gpt-4"), "status bar should show model");
      assert.ok(dom.statusBar.textContent.includes("/home/user"), "status bar should show cwd");
    });

    it("sends cancel when /cancel is used while busy", async () => {
      setFetch(() => ({ ok: true, json: async () => ({}), text: async () => '{}' }));
      state.sessionId = "s1";
      state.busy = true;

      const handled = await commands.handleSlashCommand("/cancel");
      await new Promise(r => setTimeout(r, 0)); // flush microtask (fire-and-forget)

      assert.equal(handled, true);
      // sendCancel now uses REST POST /api/v1/sessions/:id/cancel
      const cancelCall = fetchCalls.find(c => c.url.includes("/cancel"));
      assert.ok(cancelCall, "expected a cancel fetch call");
      assert.equal(cancelCall!.url, "/api/v1/sessions/s1/cancel");
      assert.equal(cancelCall!.init?.method, "POST");
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
      setFetch(() => ({ ok: true, json: async () => ({}) }));
      state.clientId = "cl-1";
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
      const putCall = fetchCalls.find(c => c.url === "/api/v1/sessions/s1/model" && c.init?.method === "PUT");
      assert.ok(putCall, "expected a PUT call");
      const body = JSON.parse(putCall!.init.body);
      assert.equal(body.value, "claude-sonnet-4.6");
      assert.ok(messageLines().includes("Model → Claude Sonnet 4.6"));
    });

    it("reports ambiguous config matches without sending an update", async () => {
      state.clientId = "cl-1";
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
      const putCall = fetchCalls.find(c => c.init?.method === "PUT");
      assert.equal(putCall, undefined, "should not send a PUT call for ambiguous match");
      assert.ok(messageLines().includes('err: Ambiguous "sonnet". Type /model + space to see options.'));
    });

    describe("/rename", () => {
      it("shows usage when no argument given", async () => {
        state.sessionId = "s1";
        state.sessionTitle = "Old Title";

        const handled = await commands.handleSlashCommand("/rename");

        assert.equal(handled, true);
        assert.ok(messageLines().some(l => l.includes("Old Title")));
        assert.ok(messageLines().some(l => l.includes("Usage")));
      });

      it("shows error when no active session", async () => {
        const handled = await commands.handleSlashCommand("/rename New Title");

        assert.equal(handled, true);
        assert.ok(messageLines().some(l => l.includes("No active session")));
      });

      it("calls PUT /api/v1/sessions/:id/title with the new title", async () => {
        setFetch(() => ({ ok: true, json: async () => ({ title: "New Title" }), text: async () => '{"title":"New Title"}' }));
        state.sessionId = "s1";

        const handled = await commands.handleSlashCommand("/rename New Title");
        await new Promise(r => setTimeout(r, 0));

        assert.equal(handled, true);
        const putCall = fetchCalls.find(c => c.url.includes("/title") && c.init?.method === "PUT");
        assert.ok(putCall, "expected a PUT call to /title");
        assert.equal(putCall!.url, "/api/v1/sessions/s1/title");
        const body = JSON.parse(putCall!.init.body);
        assert.equal(body.value, "New Title");
        assert.ok(messageLines().some(l => l.includes("Renamed")));
      });

      it("shows error on fetch failure", async () => {
        setFetch(() => { throw new Error("network"); });
        state.sessionId = "s1";

        const handled = await commands.handleSlashCommand("/rename Bad");

        assert.equal(handled, true);
        assert.ok(messageLines().some(l => l.includes("Failed to rename")));
      });
    });
  });
});
