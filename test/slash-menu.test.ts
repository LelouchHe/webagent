import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("slash menu — Tab vs Click behavior", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let slashCommands: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    (globalThis as any).Notification = {
      permission: "default",
      requestPermission: async () => "default",
    };
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    slashCommands = await import("../public/js/slash-commands.ts");
    commands = await import("../public/js/commands.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    (globalThis as any).Notification = {
      permission: "default",
      requestPermission: async () => "default",
    };
    fetchCalls = [];
    globalThis.fetch = ((url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ publicKey: "test-key" }),
      });
    }) as any;
    state.clientId = "cl-1";
    state.sessionId = "s1";
  });

  function makeTabEvent(): any {
    return { key: "Tab", preventDefault() {} };
  }

  function messageLines(): string[] {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  // -----------------------------------------------------------------------
  // Tab: always fills input, never executes
  // -----------------------------------------------------------------------

  it("Tab on top-level command fills input without executing", () => {
    dom.input.value = "/";
    commands.updateSlashMenu();
    assert.ok(
      dom.slashMenu.classList.contains("active"),
      "menu should be active",
    );

    const handled = commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(handled, true, "Tab should be handled");
    // Input should have a command filled in (e.g. "/cancel" or "/help")
    assert.ok(
      dom.input.value.startsWith("/"),
      `input should have command, got: ${dom.input.value}`,
    );
    // No system messages should appear (no execution)
    assert.equal(
      messageLines().length,
      0,
      "Tab should not execute the command",
    );
  });

  it("Tab on notify submenu fills input with /notify <option> without executing", async () => {
    dom.input.value = "/notify ";
    commands.updateSlashMenu();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      dom.slashMenu.classList.contains("active"),
      "notify submenu should be active",
    );

    const handled = commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(handled, true, "Tab should be handled");
    // Input should be filled with the full command
    assert.ok(
      dom.input.value.startsWith("/notify ") &&
        dom.input.value.length > "/notify ".length,
      `input should have /notify on or /notify off, got: "${dom.input.value}"`,
    );
    // No execution — no system messages
    assert.equal(messageLines().length, 0, "Tab should not execute /notify");
  });

  it("Tab on config submenu fills input with /model <option> without executing", () => {
    state.configOptions = [
      {
        id: "model",
        name: "Model",
        options: [
          { value: "opus", name: "opus" },
          { value: "sonnet", name: "sonnet" },
        ],
      },
    ];
    dom.input.value = "/model ";
    commands.updateSlashMenu();
    assert.ok(
      dom.slashMenu.classList.contains("active"),
      "model submenu should be active",
    );

    const handled = commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(handled, true, "Tab should be handled");
    assert.ok(
      dom.input.value.startsWith("/model "),
      `input should have /model <name>, got: "${dom.input.value}"`,
    );
    // No REST PUT sent (no execution)
    const putCall = fetchCalls.find((c) => c.init?.method === "PUT");
    assert.equal(putCall, undefined, "Tab should not send config change");
  });

  it("Tab on config submenu uses option name not value", () => {
    state.configOptions = [
      {
        id: "mode",
        name: "Mode",
        options: [
          { value: "https://some-uri/agent", name: "Agent" },
          { value: "https://some-uri/plan", name: "Plan" },
        ],
      },
    ];
    dom.input.value = "/mode ";
    commands.updateSlashMenu();

    commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(
      dom.input.value,
      "/mode Agent",
      "should use name, not URI value",
    );
  });

  it("/clear menu lists recent paths", async () => {
    state.sessionCwd = "/current";
    globalThis.fetch = ((url: string, init?: any) => {
      fetchCalls.push({ url, init });
      const data = [
        { cwd: "/current", last_used_at: "2026-04-29 09:00:00" },
        { cwd: "/tmp/other", last_used_at: "2026-04-29 08:00:00" },
      ];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(data),
      });
    }) as any;

    dom.input.value = "/clear ";
    commands.updateSlashMenu();
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(
      fetchCalls.some((c) => c.url === "/api/v1/recent-paths?limit=10"),
      "should fetch recent paths",
    );
    assert.ok(dom.slashMenu.textContent.includes("/current"));
    assert.ok(dom.slashMenu.textContent.includes("/tmp/other"));
  });

  it("/clear freeform row uses clear wording when typing a path", () => {
    dom.input.value = "/clear /tmp/new-place";
    commands.updateSlashMenu();

    assert.ok(
      dom.slashMenu.textContent.includes("clear and start at '/tmp/new-place'"),
      `expected clear freeform row, got: ${dom.slashMenu.textContent}`,
    );
  });

  // -----------------------------------------------------------------------
  // Click: fills input AND executes (tab + enter)
  // -----------------------------------------------------------------------

  it("click on notify submenu item executes the command", async () => {
    dom.input.value = "/notify ";
    commands.updateSlashMenu();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom.slashMenu.classList.contains("active"));

    // Simulate click on first item
    const item = dom.slashMenu.querySelector(".slash-item");
    assert.ok(item, "menu should have items");
    const mouseEvent = new (globalThis.window as any).MouseEvent("mousedown", {
      bubbles: true,
    });
    item.dispatchEvent(mouseEvent);

    // handleSlashCommand is async — wait a tick
    await new Promise((r) => setTimeout(r, 10));

    // Should have executed — system message should appear
    const lines = messageLines();
    assert.ok(
      lines.length > 0,
      `click should execute command, got no messages`,
    );
  });

  it("click on config submenu item executes the command", () => {
    state.configOptions = [
      {
        id: "model",
        name: "Model",
        options: [
          { value: "opus", name: "opus" },
          { value: "sonnet", name: "sonnet" },
        ],
      },
    ];
    dom.input.value = "/model ";
    commands.updateSlashMenu();
    assert.ok(dom.slashMenu.classList.contains("active"));

    // Simulate click on first item
    const item = dom.slashMenu.querySelector(".slash-item");
    assert.ok(item, "menu should have items");
    const mouseEvent = new (globalThis.window as any).MouseEvent("mousedown", {
      bubbles: true,
    });
    item.dispatchEvent(mouseEvent);

    // Should have sent a config change via REST PUT
    const putCall = fetchCalls.find(
      (c) => c.url === "/api/v1/sessions/s1/model" && c.init?.method === "PUT",
    );
    assert.ok(putCall, "click should execute config change via REST");
    const body = JSON.parse(putCall.init.body);
    assert.equal(body.value, "opus");
  });

  it("menu /exit suppresses failed delete cleanup", async () => {
    state.sessionId = "s1";
    state.sessionCwd = "/tmp/project";
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      globalThis.fetch = ((url: string, init?: any) => {
        fetchCalls.push({ url, init });
        if (url === "/api/v1/sessions/s1" && init?.method === "DELETE") {
          return Promise.reject(new Error("delete failed"));
        }
        const respond = (obj: any) =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(obj),
            text: () => Promise.resolve(JSON.stringify(obj)),
          });
        if (url === "/api/v1/sessions" && !init?.method) {
          return respond([{ id: "s1" }]);
        }
        if (url === "/api/v1/sessions" && init?.method === "POST") {
          return respond({ id: "new-session" });
        }
        return respond({});
      }) as any;

      const exitNode = slashCommands.ROOT.children.find(
        (node: any) => node.name === "/exit",
      );
      assert.ok(exitNode, "expected /exit command node");
      await exitNode.onSelect();
      await new Promise((r) => setTimeout(r, 0));

      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("inbox consume — switches session via switchToSession", () => {
  let state: any;
  let dom: any;
  let slashCommands: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    await import("../public/js/events.ts");
    slashCommands = await import("../public/js/slash-commands.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    state.sessionId = "old-session";
    globalThis.fetch = ((url: string, init?: any) => {
      fetchCalls.push({ url, init });
      const respond = (obj: any) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(obj),
          text: () => Promise.resolve(JSON.stringify(obj)),
        });
      if (url.includes("/messages/") && url.endsWith("/consume")) {
        return respond({ sessionId: "new-session", alreadyConsumed: false });
      }
      if (url === "/api/v1/sessions/new-session") {
        return respond({
          id: "new-session",
          cwd: "/x",
          title: "from inbox",
          configOptions: [],
          busyKind: null,
        });
      }
      if (url.includes("/events")) {
        return respond({
          events: [],
          streaming: { thinking: false, assistant: false },
        });
      }
      return respond({});
    }) as any;
  });

  it("consumeInbox switches session state to the consumed sessionId", async () => {
    await slashCommands.consumeInbox({
      id: "m1",
      from_ref: "x",
      title: "t",
      body: "b",
      createdAt: 0,
    } as any);
    assert.equal(
      state.sessionId,
      "new-session",
      "should switch to the new session",
    );
    const consumeCall = fetchCalls.find((c) => c.url.endsWith("/consume"));
    assert.ok(consumeCall, "should call consume endpoint");
    const sessionCall = fetchCalls.find(
      (c) => c.url === "/api/v1/sessions/new-session",
    );
    assert.ok(
      sessionCall,
      "should fetch new session metadata (proves switchToSession ran)",
    );
  });
});
