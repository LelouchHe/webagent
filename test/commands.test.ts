import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import { LOG_LEVEL_STORAGE_KEY } from "../public/js/local-reset.ts";

describe("commands", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let events: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    events = await import("../public/js/events.ts");
    commands = await import("../public/js/commands.ts");
  });

  after(() => {
    teardownDOM();
  });
  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    localStorage.clear();
    fetchCalls = [];
    globalThis.fetch = undefined as any;
  });

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  function setFetch(handler: (url: string, init?: any) => Promise<any> | any) {
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return handler(url, init);
    }) as any;
  }

  function messageLines() {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  it("shows model IDs as dim secondary menu text", () => {
    state.configOptions = [
      {
        id: "model",
        name: "Model",
        currentValue: "gpt-5.6-sol",
        options: [
          { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { value: "gpt-5.4-mini", name: "GPT-5.4 mini" },
        ],
      },
    ];
    dom.input.value = "/model ";

    commands.updateSlashMenu();

    const rows = [...dom.slashMenu.querySelectorAll(".slash-item")];
    assert.deepEqual(
      rows.map((row: any) => ({
        name: row.querySelector(".slash-primary")?.textContent,
        id: row.querySelector(".slash-secondary")?.textContent,
      })),
      [
        { name: "GPT-5.6 Sol", id: "(gpt-5.6-sol)" },
        { name: "GPT-5.4 mini", id: "(gpt-5.4-mini)" },
      ],
    );
  });

  describe("handleSlashCommand", () => {
    it("creates a new session using the provided cwd", async () => {
      setFetch(() => ({
        ok: true,
        json: async () => ({ id: "new-1" }),
        text: async () => '{"id":"new-1"}',
      }));
      state.sessionId = "current-session";
      state.sessionCwd = "/current";

      const handled = await commands.handleSlashCommand("/new /tmp/project");
      await new Promise((r) => setTimeout(r, 0)); // flush microtask (fire-and-forget)

      assert.equal(handled, true);
      assert.equal(state.awaitingNewSession, false);
      assert.equal(state.sessionId, "new-1");
      // requestNewSession now uses REST POST /api/v1/sessions
      const createCall = fetchCalls.find(
        (c) => c.url === "/api/v1/sessions" && c.init?.method === "POST",
      );
      assert.ok(createCall, "expected POST /api/v1/sessions");
      const body = JSON.parse(createCall.init.body);
      assert.equal(body.cwd, "/tmp/project");
      assert.equal(body.inheritFromSessionId, "current-session");
      assert.ok(messageLines().includes("Creating new session…"));
    });

    it("inherits current session cwd when /new has no argument", async () => {
      setFetch(() => ({
        ok: true,
        json: async () => ({ id: "new-2" }),
        text: async () => '{"id":"new-2"}',
      }));
      state.sessionId = "current-session";
      state.sessionCwd = "/my/project";

      const handled = await commands.handleSlashCommand("/new");
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(handled, true);
      const createCall = fetchCalls.find(
        (c) => c.url === "/api/v1/sessions" && c.init?.method === "POST",
      );
      assert.ok(createCall, "expected POST /api/v1/sessions");
      const body = JSON.parse(createCall.init.body);
      assert.equal(
        body.cwd,
        "/my/project",
        "should inherit cwd from current session",
      );
    });

    it("shows help for ? and lists /help in commands", async () => {
      const handled = await commands.handleSlashCommand("?");

      assert.equal(handled, true);
      const lines = messageLines();
      assert.ok(lines.includes("? — Show help"));
      assert.ok(lines.includes("/help — Show help"));
      assert.ok(lines.includes("!<command> — Run bash command"));
      assert.ok(lines.includes("// — Agent commands (agent-specific)"));
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
      assert.ok(!lines.some((l) => l.includes("WebAgent")));
    });

    it("still accepts /help for backwards compatibility", async () => {
      const handled = await commands.handleSlashCommand("/help");

      assert.equal(handled, true);
      const lines = messageLines();
      assert.ok(lines.includes("? — Show help"));
    });

    it("toggles, hides, and restores the active plan panel", async () => {
      events.handleEvent({
        type: "plan",
        entries: [{ content: "Implement panel", status: "in_progress" }],
      });
      state.sessionId = "s1";
      events.handleEvent({
        type: "state_patch",
        sessionId: "s1",
        seq: 1,
        patch: {
          runtime: {
            plan: [{ content: "Implement panel", status: "in_progress" }],
          },
        },
      });
      const panel = document.querySelector("#plan-panel") as HTMLDetailsElement;
      assert.equal(panel.hidden, false);

      assert.equal(await commands.handleSlashCommand("/plan hide"), true);
      assert.equal(panel.hidden, true);
      events.handleEvent({
        type: "plan",
        entries: [{ content: "Updated while hidden", status: "in_progress" }],
      });
      events.handleEvent({
        type: "state_patch",
        sessionId: "s1",
        seq: 2,
        patch: {
          runtime: {
            plan: [{ content: "Updated while hidden", status: "in_progress" }],
          },
        },
      });
      assert.equal(panel.hidden, true);
      assert.equal(await commands.handleSlashCommand("/plan show"), true);
      assert.equal(panel.hidden, false);
      assert.equal(panel.open, false);
      assert.equal(
        panel.querySelector(".plan-entry")?.textContent,
        "[~] Updated while hidden",
      );
      assert.equal(await commands.handleSlashCommand("/plan"), true);
      assert.equal(panel.hidden, true);
      assert.equal(await commands.handleSlashCommand("/plan"), true);
      assert.equal(panel.hidden, false);
    });

    it("shows the unified error for an unknown local slash command", async () => {
      const handled = await commands.handleSlashCommand("/does-not-exist arg");

      assert.equal(handled, true);
      assert.ok(
        messageLines().includes(
          'err: Unknown command "/does-not-exist". Type / to see available commands.',
        ),
      );
    });

    it("exits current session — deletes it and switches to MRU", async () => {
      state.clientId = "cl-1";
      state.sessionId = "current";
      const configOptions = [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "gpt-4",
          options: [],
        },
      ];
      const sessionList = [
        { id: "current", title: "Current Session" },
        { id: "mru-456", title: "MRU Session" },
      ];
      const mruDetail = {
        id: "mru-456",
        cwd: "/home",
        title: "MRU Session",
        configOptions,
        busyKind: null,
      };
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return {
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => json,
          };
        };
        if (
          url === "/api/v1/sessions" &&
          (!init?.method || init.method === "GET")
        )
          return body(sessionList);
        if (url === "/api/v1/sessions/current" && init?.method === "DELETE")
          return body({});
        if (url === "/api/v1/sessions/mru-456") return body(mruDetail);
        if (url.includes("/api/v1/sessions/mru-456/events")) return body([]);
        if (url === "/api/v1/sessions/mru-456/snapshot") {
          return body({
            version: 1,
            seq: 0,
            session: {},
            runtime: { busy: null },
          });
        }
        return body({});
      });

      const handled = await commands.handleSlashCommand("/exit");

      assert.equal(handled, true);
      const deleteCall = fetchCalls.find(
        (c) =>
          c.url === "/api/v1/sessions/current" && c.init?.method === "DELETE",
      );
      assert.ok(deleteCall, "expected DELETE for current session");
      assert.equal(state.sessionId, "mru-456");
    });

    it("exits current session — updates URL hash before async load to prevent SSE reconnect race", async () => {
      state.clientId = "cl-1";
      state.sessionId = "current";
      location.hash = "#current";
      const configOptions = [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "gpt-4",
          options: [],
        },
      ];
      const sessionList = [
        { id: "current", title: "Current Session" },
        { id: "mru-456", title: "MRU Session" },
      ];
      const mruDetail = {
        id: "mru-456",
        cwd: "/home",
        title: "MRU Session",
        configOptions,
        busyKind: null,
      };

      let hashDuringAsyncLoad: string | null = null;
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return {
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => json,
          };
        };
        if (
          url === "/api/v1/sessions" &&
          (!init?.method || init.method === "GET")
        )
          return body(sessionList);
        if (url === "/api/v1/sessions/current" && init?.method === "DELETE")
          return body({});
        if (
          url === "/api/v1/sessions/mru-456" &&
          (!init?.method || init.method === "GET")
        ) {
          // Capture the hash at the point where the async load happens.
          // If SSE reconnects here, initSession() reads location.hash to decide which session to load.
          hashDuringAsyncLoad = location.hash;
          return body(mruDetail);
        }
        if (url.includes("/api/v1/sessions/mru-456/events")) return body([]);
        if (url === "/api/v1/sessions/mru-456/snapshot") {
          return body({
            version: 1,
            seq: 0,
            session: {},
            runtime: { busy: null },
          });
        }
        return body({});
      });

      await commands.handleSlashCommand("/exit");

      assert.equal(
        hashDuringAsyncLoad,
        "#mru-456",
        "URL hash must point to next session before async load, otherwise SSE reconnect loads the deleted session",
      );
    });

    it("exits last session — deletes it and creates a new one", async () => {
      state.clientId = "cl-1";
      state.sessionId = "only-one";
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return {
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => json,
          };
        };
        if (
          url === "/api/v1/sessions" &&
          (!init?.method || init.method === "GET")
        ) {
          return body([{ id: "only-one", title: "Only Session" }]);
        }
        if (url === "/api/v1/sessions/only-one" && init?.method === "DELETE")
          return body({});
        if (url === "/api/v1/sessions" && init?.method === "POST")
          return body({ id: "new-1" });
        return body({});
      });

      const handled = await commands.handleSlashCommand("/exit");

      assert.equal(handled, true);
      const deleteCall = fetchCalls.find(
        (c) =>
          c.url === "/api/v1/sessions/only-one" && c.init?.method === "DELETE",
      );
      assert.ok(deleteCall, "expected DELETE for the only session");
      assert.equal(state.awaitingNewSession, true);
    });

    it("clears current session in place without deleting its history", async () => {
      state.clientId = "cl-1";
      state.sessionId = "old-1";
      state.sessionCwd = "/home/project";
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return {
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => json,
          };
        };
        if (url === "/api/v1/sessions/old-1/clear" && init?.method === "POST")
          return body({ id: "old-1", cwd: "/home/project", configOptions: [] });
        if (url === "/api/v1/sessions/old-1")
          return body({ id: "old-1", cwd: "/home/project", configOptions: [] });
        if (url.includes("/snapshot"))
          return body({
            seq: 0,
            session: {
              id: "old-1",
              title: null,
              cwd: "/home/project",
              model: null,
              mode: null,
            },
            runtime: { busy: null, plan: null, contextUsage: null },
            agentCommands: { epoch: "", revision: 0, commands: [] },
          });
        if (url.includes("/events")) return body([]);
        return body({});
      });

      const handled = await commands.handleSlashCommand("/clear");
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(handled, true);
      const clearCall = fetchCalls.find(
        (c) =>
          c.url === "/api/v1/sessions/old-1/clear" && c.init?.method === "POST",
      );
      assert.ok(clearCall, "expected POST /api/v1/sessions/old-1/clear");
      assert.deepEqual(JSON.parse(clearCall.init.body), {
        cwd: "/home/project",
      });
      assert.equal(
        fetchCalls.some(
          (c) =>
            c.url === "/api/v1/sessions/old-1" && c.init?.method === "DELETE",
        ),
        false,
      );
      assert.equal(state.awaitingNewSession, false);
      assert.equal(state.sessionId, "old-1");
      assert.ok(messageLines().includes("Clearing session…"));
    });

    it("keeps the current session when clear request fails", async () => {
      state.clientId = "cl-1";
      state.sessionId = "old-1";
      state.sessionCwd = "/home/project";
      setFetch(async (url: string, init?: RequestInit) => {
        if (url === "/api/v1/sessions/old-1/clear" && init?.method === "POST") {
          throw new Error("response interrupted");
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      assert.equal(await commands.handleSlashCommand("/clear"), true);
      assert.equal(state.sessionId, "old-1");
      assert.ok(
        messageLines().some((line: string) =>
          line.includes("Failed to clear session"),
        ),
      );
    });

    it("clears current session into the provided cwd", async () => {
      state.clientId = "cl-1";
      state.sessionId = "old-1";
      state.sessionCwd = "/home/project";
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return {
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => json,
          };
        };
        if (url === "/api/v1/sessions/old-1/clear" && init?.method === "POST")
          return body({ id: "old-1", cwd: "/tmp/other", configOptions: [] });
        if (url === "/api/v1/sessions/old-1")
          return body({ id: "old-1", cwd: "/tmp/other", configOptions: [] });
        if (url.includes("/snapshot"))
          return body({
            seq: 0,
            session: {
              id: "old-1",
              title: null,
              cwd: "/tmp/other",
              model: null,
              mode: null,
            },
            runtime: { busy: null, plan: null, contextUsage: null },
            agentCommands: { epoch: "", revision: 0, commands: [] },
          });
        if (url.includes("/events")) return body([]);
        return body({});
      });

      const handled = await commands.handleSlashCommand("/clear /tmp/other");
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(handled, true);
      const clearCall = fetchCalls.find(
        (c) =>
          c.url === "/api/v1/sessions/old-1/clear" && c.init?.method === "POST",
      );
      assert.ok(clearCall, "expected POST /api/v1/sessions/old-1/clear");
      const clearBody = JSON.parse(clearCall.init.body);
      assert.equal(clearBody.cwd, "/tmp/other");
      assert.ok(
        messageLines().includes("Clearing session and starting at /tmp/other…"),
      );
    });

    // Regression coverage: clearing is an asynchronous ACP replacement, but it
    // must not trigger session navigation to a different WebAgent Session.
    it("/clear keeps the stable session when the endpoint is slow", async () => {
      state.clientId = "cl-1";
      state.sessionId = "old";
      state.sessionCwd = "/p";
      let resolveClear!: (response: any) => void;
      setFetch(async (url: string, init?: any) => {
        const body = (data: any) => {
          const json = JSON.stringify(data);
          return {
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => json,
          };
        };
        if (url === "/api/v1/sessions/old/clear" && init?.method === "POST") {
          return new Promise((resolve) => {
            resolveClear = resolve;
          });
        }
        if (url === "/api/v1/sessions/old")
          return body({ id: "old", cwd: "/p", title: null, configOptions: [] });
        if (url.includes("/events"))
          return body({
            events: [],
            streaming: { assistant: false, thinking: false },
          });
        if (url.includes("/snapshot"))
          return body({
            version: 1,
            seq: 0,
            session: {
              id: "old",
              title: null,
              cwd: "/p",
              model: null,
              mode: null,
              createdAt: null,
              lastEventSeq: 0,
            },
            runtime: { busy: null, plan: null, contextUsage: null },
            agentCommands: { epoch: "", revision: 0, commands: [] },
          });
        return body({});
      });

      const pending = commands.handleSlashCommand("/clear");
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(
        fetchCalls.some(
          (call) =>
            call.url === "/api/v1/sessions/old/clear" &&
            call.init?.method === "POST",
        ),
      );

      resolveClear({
        ok: true,
        status: 200,
        json: async () => ({ id: "old", cwd: "/p", configOptions: [] }),
        text: async () => '{"id":"old","cwd":"/p","configOptions":[]}',
      });
      assert.equal(await pending, true);
      assert.equal(state.sessionId, "old");
      assert.equal(state.awaitingNewSession, false);
    });

    it("clear without active session warns and does nothing", async () => {
      state.sessionId = null;
      setFetch(() => ({
        ok: true,
        json: async () => ({}),
        text: async () => "{}",
      }));

      const handled = await commands.handleSlashCommand("/clear");

      assert.equal(handled, true);
      assert.equal(fetchCalls.length, 0);
      assert.ok(
        messageLines().some((l: string) => l.includes("No active session")),
      );
    });

    it("switches to a matching session and loads history", async () => {
      state.clientId = "cl-1";
      state.sessionId = "current";
      const configOptions = [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "gpt-4",
          options: [],
        },
      ];
      setFetch(async (url: string) => {
        if (url === "/api/v1/sessions") {
          return {
            json: async () => [{ id: "target-1", title: "Target Session" }],
          };
        }
        if (url.startsWith("/api/v1/sessions/target-1/events")) {
          return {
            ok: true,
            json: async () => [
              {
                type: "assistant_message",
                data: JSON.stringify({ text: "history item" }),
              },
            ],
          };
        }
        if (url === "/api/v1/sessions/target-1") {
          const data = {
            id: "target-1",
            cwd: "/home/user",
            title: "Target Session",
            configOptions,
            busyKind: null,
          };
          return {
            ok: true,
            json: async () => data,
            text: async () => JSON.stringify(data),
          };
        }
        if (url === "/api/v1/sessions/target-1/snapshot") {
          const data = {
            version: 1,
            seq: 0,
            session: {},
            runtime: { busy: null },
          };
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
      assert.ok(
        fetchCalls.some((c) => c.url === "/api/v1/sessions"),
        "should list sessions",
      );
      assert.ok(
        fetchCalls.some((c) =>
          c.url.startsWith("/api/v1/sessions/target-1/events"),
        ),
        "should load events",
      );
      assert.ok(
        fetchCalls.some(
          (c) =>
            c.url === "/api/v1/sessions/target-1" &&
            (!c.init?.method || c.init.method === "GET"),
        ),
        "should GET session to trigger auto-resume",
      );
      assert.equal(state.sessionId, "target-1");
      assert.equal(state.sessionTitle, "Target Session");
      assert.equal(globalThis.location.hash, "#target-1");
      assert.equal(dom.sessionInfo.textContent, "Target Session");
      assert.ok(dom.messages.textContent.includes("history item"));
      // Status bar should show model and cwd after switch
      assert.ok(
        dom.statusBar.textContent.includes("gpt-4"),
        "status bar should show model",
      );
      assert.ok(
        dom.statusBar.textContent.includes("/home/user"),
        "status bar should show cwd",
      );
    });

    it("sends cancel when /cancel is used while busy", async () => {
      setFetch(() => ({
        ok: true,
        json: async () => ({}),
        text: async () => "{}",
      }));
      state.sessionId = "s1";
      state.busy = true;

      const handled = await commands.handleSlashCommand("/cancel");
      await new Promise((r) => setTimeout(r, 0)); // flush microtask (fire-and-forget)

      assert.equal(handled, true);
      // sendCancel now uses REST POST /api/v1/sessions/:id/cancel
      const cancelCall = fetchCalls.find((c) => c.url.includes("/cancel"));
      assert.ok(cancelCall, "expected a cancel fetch call");
      assert.equal(cancelCall.url, "/api/v1/sessions/s1/cancel");
      assert.equal(cancelCall.init?.method, "POST");
      assert.ok(messageLines().includes("^C cancelling…"));
    });

    it("sends /cancel even when frontend state is incorrectly idle", async () => {
      setFetch(() => ({
        ok: true,
        json: async () => ({ ok: true, status: "cancelling" }),
        text: async () => JSON.stringify({ ok: true, status: "cancelling" }),
      }));
      state.sessionId = "s1";
      state.busy = false;

      assert.equal(await commands.handleSlashCommand("/cancel"), true);
      await new Promise((r) => setTimeout(r, 0));

      const cancelCall = fetchCalls.find((c) => c.url.includes("/cancel"));
      assert.ok(cancelCall, "expected an authoritative cancel fetch call");
      assert.equal(cancelCall.url, "/api/v1/sessions/s1/cancel");
      assert.equal(cancelCall.init?.method, "POST");
      assert.ok(messageLines().includes("^C cancelling…"));
    });

    it("persists /log level locally", async () => {
      const handled = await commands.handleSlashCommand("/log debug");

      assert.equal(handled, true);
      assert.equal(localStorage.getItem(LOG_LEVEL_STORAGE_KEY), "debug");
      assert.ok(messageLines().includes("log: debug (local) saved"));
    });

    it("/log reset clears the local level override", async () => {
      localStorage.setItem(LOG_LEVEL_STORAGE_KEY, "debug");
      await commands.handleSlashCommand("/log reset");

      assert.equal(localStorage.getItem(LOG_LEVEL_STORAGE_KEY), null);
      assert.ok(messageLines().includes("log: off (default) reset"));
    });

    it("reports the selected config value when no /model arg is given", async () => {
      state.configOptions = [
        {
          id: "model",
          name: "Model",
          currentValue: "claude-sonnet-4.6",
          options: [
            { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
            { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
          ],
        },
      ];

      const handled = await commands.handleSlashCommand("/model");

      assert.equal(handled, true);
      assert.ok(messageLines().includes("Model: Claude Sonnet 4.6"));
      assert.ok(
        messageLines().includes("Type /model + space to pick from list"),
      );
    });

    it("switches config options using fuzzy matching", async () => {
      setFetch(() => ({ ok: true, json: async () => ({}) }));
      state.clientId = "cl-1";
      state.sessionId = "s1";
      state.configOptions = [
        {
          id: "model",
          name: "Model",
          currentValue: "claude-haiku-4.5",
          options: [
            { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
            { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
          ],
        },
      ];

      const handled = await commands.handleSlashCommand("/model sonnet");

      assert.equal(handled, true);
      const putCall = fetchCalls.find(
        (c) =>
          c.url === "/api/v1/sessions/s1/model" && c.init?.method === "PUT",
      );
      assert.ok(putCall, "expected a PUT call");
      const body = JSON.parse(putCall.init.body);
      assert.equal(body.value, "claude-sonnet-4.6");
      assert.ok(messageLines().includes("Model → Claude Sonnet 4.6"));
    });

    it("reports ambiguous config matches without sending an update", async () => {
      state.clientId = "cl-1";
      state.sessionId = "s1";
      state.configOptions = [
        {
          id: "model",
          name: "Model",
          currentValue: "claude-haiku-4.5",
          options: [
            { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
            { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          ],
        },
      ];

      const handled = await commands.handleSlashCommand("/model sonnet");

      assert.equal(handled, true);
      const putCall = fetchCalls.find((c) => c.init?.method === "PUT");
      assert.equal(
        putCall,
        undefined,
        "should not send a PUT call for ambiguous match",
      );
      assert.ok(
        messageLines().includes(
          'err: Ambiguous "sonnet". Type /model + space to see options.',
        ),
      );
    });

    describe("/rename", () => {
      it("shows usage when no argument given", async () => {
        state.sessionId = "s1";
        state.sessionTitle = "Old Title";

        const handled = await commands.handleSlashCommand("/rename");

        assert.equal(handled, true);
        assert.ok(messageLines().some((l) => l.includes("Old Title")));
        assert.ok(messageLines().some((l) => l.includes("Usage")));
      });

      it("shows error when no active session", async () => {
        const handled = await commands.handleSlashCommand("/rename New Title");

        assert.equal(handled, true);
        assert.ok(messageLines().some((l) => l.includes("No active session")));
      });

      it("calls PUT /api/v1/sessions/:id/title with the new title", async () => {
        setFetch(() => ({
          ok: true,
          json: async () => ({ title: "New Title" }),
          text: async () => '{"title":"New Title"}',
        }));
        state.sessionId = "s1";

        const handled = await commands.handleSlashCommand("/rename New Title");
        await new Promise((r) => setTimeout(r, 0));

        assert.equal(handled, true);
        const putCall = fetchCalls.find(
          (c) => c.url.includes("/title") && c.init?.method === "PUT",
        );
        assert.ok(putCall, "expected a PUT call to /title");
        assert.equal(putCall.url, "/api/v1/sessions/s1/title");
        const body = JSON.parse(putCall.init.body);
        assert.equal(body.value, "New Title");
        assert.ok(messageLines().some((l) => l.includes("Renamed")));
      });

      it("shows error on fetch failure", async () => {
        setFetch(() => {
          throw new Error("network");
        });
        state.sessionId = "s1";

        const handled = await commands.handleSlashCommand("/rename Bad");

        assert.equal(handled, true);
        assert.ok(messageLines().some((l) => l.includes("Failed to rename")));
      });
    });

    describe("/reload", () => {
      it("calls POST /api/v1/bridge/reload and shows system message", async () => {
        setFetch(() => ({
          ok: true,
          json: async () => ({ ok: true }),
          text: async () => '{"ok":true}',
        }));

        const handled = await commands.handleSlashCommand("/reload");
        await new Promise((r) => setTimeout(r, 0));

        assert.equal(handled, true);
        const reloadCall = fetchCalls.find(
          (c) => c.url === "/api/v1/bridge/reload" && c.init?.method === "POST",
        );
        assert.ok(reloadCall, "expected POST /api/v1/bridge/reload");
        assert.ok(messageLines().some((l) => l.includes("Reloading")));
      });

      it("shows error on reload failure", async () => {
        setFetch(() => ({
          ok: false,
          status: 500,
          json: async () => ({ error: "agent crashed" }),
          text: async () => '{"error":"agent crashed"}',
        }));

        const handled = await commands.handleSlashCommand("/reload");
        await new Promise((r) => setTimeout(r, 0));

        assert.equal(handled, true);
        assert.ok(
          messageLines().some(
            (l) => l.includes("agent crashed") ?? l.includes("Failed"),
          ),
        );
      });
    });
  });
});
