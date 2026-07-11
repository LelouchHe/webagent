import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetState, setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("agent slash frontend", () => {
  let stateMod: typeof import("../public/js/state.ts");
  let events: typeof import("../public/js/events.ts");
  let commands: typeof import("../public/js/commands.ts");
  let state: typeof import("../public/js/state.ts").state;
  let dom: typeof import("../public/js/state.ts").dom;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    events = await import("../public/js/events.ts");
    commands = await import("../public/js/commands.ts");
    await import("../public/js/input.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    fetchCalls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 202,
        json: async () => ({ status: "accepted" }),
        text: async () => '{"status":"accepted"}',
      } as Response;
    }) as typeof fetch;
    state.clientId = "client-1";
    state.sessionId = "session-1";
  });

  function setCommands(
    revision: number,
    agentCommands: typeof state.agentCommands,
  ): void {
    state.agentCommandsRevision = revision;
    state.agentCommands = agentCommands;
  }

  function pressEnter(): void {
    dom.input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function messageLines(): string[] {
    return [...dom.messages.children].map((element) => element.textContent);
  }

  it("shows only current-session agent commands for // with description and input hint", () => {
    setCommands(1, [
      {
        name: "context",
        description: "Show context usage",
      },
      {
        name: "compact",
        description: "Compact conversation",
        input: { hint: "focus instructions" },
      },
    ]);

    stateMod.setInputValue("//");
    commands.updateSlashMenu();

    assert.match(dom.slashMenu.textContent, /\/\/context/);
    assert.match(dom.slashMenu.textContent, /Show context usage/);
    assert.match(dom.slashMenu.textContent, /\/\/compact/);
    assert.match(
      dom.slashMenu.textContent,
      /Compact conversation · focus instructions/,
    );
    assert.doesNotMatch(dom.slashMenu.textContent, /<focus instructions>/);
    assert.doesNotMatch(dom.slashMenu.textContent, /\/help/);
  });

  it("Tab completes an agent command without including its input hint", () => {
    setCommands(1, [
      {
        name: "compact",
        description: "Compact conversation",
        input: { hint: "focus instructions" },
      },
    ]);
    stateMod.setInputValue("//");
    commands.updateSlashMenu();

    const handled = commands.handleSlashMenuKey({
      key: "Tab",
    } as KeyboardEvent);

    assert.equal(handled, true);
    assert.equal(dom.input.value, "//compact");
  });

  it("click sends the raw // command through the ordinary prompt API", async () => {
    setCommands(1, [{ name: "context", description: "Show context usage" }]);
    stateMod.setInputValue("//");
    commands.updateSlashMenu();

    dom.slashMenu
      .querySelector(".slash-item")!
      .dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const promptCall = fetchCalls.find(
      (call) =>
        call.url === "/api/v1/sessions/session-1/prompt" &&
        call.init?.method === "POST",
    );
    assert.ok(promptCall);
    const body = promptCall.init?.body;
    if (typeof body !== "string") throw new Error("Expected prompt JSON body");
    assert.equal(JSON.parse(body).text, "//context");
  });

  it("shows the unified unknown error and does not send undeclared commands", () => {
    setCommands(1, [{ name: "context", description: "Show context usage" }]);
    stateMod.setInputValue("//missing arg");

    pressEnter();

    assert.equal(fetchCalls.length, 0);
    assert.equal(dom.input.value, "//missing arg");
    assert.ok(
      messageLines().includes(
        'err: Unknown command "//missing". Type // to see available commands.',
      ),
    );
  });

  it("treats // as an ordinary prompt while busy", () => {
    setCommands(1, [{ name: "context", description: "Show context usage" }]);
    stateMod.setBusy(true);
    stateMod.setInputValue("//");
    commands.updateSlashMenu();

    assert.match(dom.slashMenu.textContent, /agent busy/);
    assert.equal(dom.sendBtn.textContent, "^C");
    assert.equal(
      dom.slashMenu.querySelector(".slash-item.selected") !== null,
      false,
      "busy hint must not participate in selection",
    );

    stateMod.setInputValue("//context");
    pressEnter();
    assert.equal(fetchCalls.length, 0);
    assert.equal(dom.input.value, "//context");
  });

  it("rolls back the optimistic message when the server rejects a stale command snapshot", async () => {
    setCommands(1, [{ name: "context", description: "Show context usage" }]);
    globalThis.fetch = async () => {
      return {
        ok: false,
        status: 422,
        json: async () => ({
          error: "Unknown command",
          command: "//context",
          prefix: "//",
        }),
        text: async () => "",
      } as Response;
    };
    stateMod.setInputValue("//context");

    pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(dom.input.value, "//context");
    assert.equal(dom.messages.querySelector(".msg.user"), null);
    assert.ok(
      messageLines().includes(
        'err: Unknown command "//context". Type // to see available commands.',
      ),
    );
  });

  it("advertises // in the / root menu and /help", async () => {
    stateMod.setInputValue("/");
    commands.updateSlashMenu();
    assert.match(dom.slashMenu.textContent, /Agent commands: type \/\//);

    await commands.handleSlashCommand("/help");
    assert.ok(messageLines().includes("// — Agent commands (agent-specific)"));
  });

  it("keeps the newest command revision across SSE and snapshot races", () => {
    events.handleEvent({
      type: "available_commands_update",
      sessionId: "session-1",
      epoch: "server-a",
      revision: 2,
      commands: [{ name: "context", description: "New" }],
    });
    stateMod.applySnapshot({
      version: 1,
      seq: 0,
      session: {
        id: "session-1",
        title: null,
        cwd: "/tmp",
        model: null,
        mode: null,
        createdAt: null,
        lastEventSeq: 0,
      },
      runtime: { busy: null },
      agentCommands: {
        epoch: "server-a",
        revision: 1,
        commands: [{ name: "old", description: "Stale" }],
      },
    });

    assert.equal(state.agentCommandsRevision, 2);
    assert.deepEqual(state.agentCommands, [
      { name: "context", description: "New" },
    ]);
  });

  it("accepts a lower revision after the server command epoch changes", () => {
    stateMod.applyAgentCommandSnapshot({
      epoch: "server-a",
      revision: 5,
      commands: [{ name: "context", description: "stale" }],
    });

    const applied = stateMod.applyAgentCommandSnapshot({
      epoch: "server-b",
      revision: 0,
      commands: [],
    });

    assert.equal(applied, true);
    assert.deepEqual(state.agentCommands, []);
    assert.equal(state.agentCommandsRevision, 0);
  });
});
