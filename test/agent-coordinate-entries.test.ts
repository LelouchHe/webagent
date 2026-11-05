import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The three entries that accept a coordinate — `+`, `/new`, `/clear` — share
 * one parse and one set of wire semantics.
 *
 * `+` and `/new` are creates: an empty suffix omits the cwd, which the server
 * reads as "the default directory". `/clear` keeps the task directory instead.
 * The two omissions are deliberately not interchangeable, so the entries must
 * agree on everything else and differ only where the wire contract says so.
 */

interface Call {
  url: string;
  init?: { method?: string; body?: string };
}

describe("coordinate entries", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let taskCommand: any;
  let directory: any;
  let calls: Call[];
  let handler: (url: string, init?: any) => Response | undefined;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
    taskCommand = await import("../public/js/task-command.ts");
    directory = await import("../public/js/agent-directory.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    directory.resetAgentDirectoryForTest();
    directory.installAgentDirectory(
      [
        { id: "pi", available: true },
        { id: "copilot", available: true },
      ],
      "pi",
    );
    state.clientId = "cl-1";
    state.taskId = "old-1";
    state.taskAgentId = "pi";
    state.taskCwd = "/work";
    state.taskCwdDisplay = "~/work";
    calls = [];
    handler = defaultHandler;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, init });
      const response = handler(url, init);
      if (response) return response;
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status });
  }

  function defaultHandler(url: string, init?: any): Response | undefined {
    if (url.startsWith("/api/v1/files/info?")) {
      const path = decodeURIComponent(
        url.slice("/api/v1/files/info?path=".length),
      );
      return json({
        path,
        name: "x",
        kind: "dir",
        size: 0,
        mtime: 1,
      });
    }
    if (url === "/api/v1/tasks" && init?.method === "POST") {
      return json({ id: "child-1", cwd: "/work", configOptions: [] }, 201);
    }
    if (
      /^\/api\/v1\/tasks\/[^/]+\/clear$/.test(url) &&
      init?.method === "POST"
    ) {
      return json({ id: "old-1", cwd: "/work", configOptions: [] });
    }
    if (url.includes("/snapshot")) {
      return json({
        seq: 0,
        task: {
          id: "old-1",
          title: null,
          cwd: "/work",
          model: null,
          mode: null,
        },
        runtime: { busy: null, plan: null, contextUsage: null },
        agentCommands: { epoch: "", revision: 0, commands: [] },
      });
    }
    if (url === "/api/v1/tasks") {
      return json([{ id: "old-1" }, { id: "child-1" }]);
    }
    return undefined;
  }

  function bodyOf(method: string, suffix: string): any {
    const call = calls.find(
      (entry) => entry.url.endsWith(suffix) && entry.init?.method === method,
    );
    assert.ok(
      call,
      `expected ${method} ${suffix}; got ${JSON.stringify(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`))}`,
    );
    return JSON.parse(call.init!.body ?? "{}");
  }

  function lines(): string[] {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("/clear takes the coordinate's agent and cwd", async () => {
    await commands.handleSlashCommand("/clear pi:~/a  b");
    const body = bodyOf("POST", "/api/v1/tasks/old-1/clear");
    assert.equal(body.agentId, "pi");
    assert.equal(body.cwd, "~/a  b", "interior whitespace survives the entry");
  });

  it("/new omits the cwd for an empty suffix", async () => {
    await commands.handleSlashCommand("/new copilot:");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal(body.agentId, "copilot");
    assert.equal(
      "cwd" in body,
      false,
      "an omitted cwd means the server default",
    );
    assert.equal(body.parentId, "old-1");
    assert.equal(body.inheritFromTaskId, "old-1");
  });

  it("/new passes the coordinate's raw cwd", async () => {
    await commands.handleSlashCommand("/new copilot:~/a  b");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal(body.agentId, "copilot");
    assert.equal(body.cwd, "~/a  b");
  });

  it("+ passes the coordinate's agent and raw cwd", async () => {
    await taskCommand.executeTaskCommand("+fix copilot:~/a  b");
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal(body.agentId, "copilot");
    assert.equal(body.cwd, "~/a  b");
    assert.equal(body.title, "fix");
    assert.equal(body.parentId, "old-1");
  });

  it("all three entries project to the same agent and cwd", async () => {
    // A relative suffix resolves against the task cwd for every entry, and an
    // interior double space is not collapsed by the old slash normalization.
    const inputs = [
      { command: "/clear copilot:rel", cwd: "/work/rel" },
      { command: "/new copilot:rel", cwd: "/work/rel" },
      { command: "+fix copilot:rel", cwd: "/work/rel" },
      { command: "/clear copilot:~/a  b", cwd: "~/a  b" },
      { command: "/new copilot:~/a  b", cwd: "~/a  b" },
      { command: "+fix copilot:~/a  b", cwd: "~/a  b" },
    ];
    for (const input of inputs) {
      state.taskId = "old-1";
      calls = [];
      if (input.command.startsWith("+")) {
        await taskCommand.executeTaskCommand(input.command);
      } else {
        await commands.handleSlashCommand(input.command);
        await settle();
      }
      const create = calls.find(
        (call) => call.init?.method === "POST" && call.url === "/api/v1/tasks",
      );
      const clear = calls.find((call) => call.url.endsWith("/clear"));
      const body = JSON.parse((create ?? clear)!.init!.body ?? "{}");
      assert.equal(body.agentId, "copilot", input.command);
      assert.equal(body.cwd, input.cwd, input.command);
    }
  });

  it("treats an unconfigured prefix as a path", async () => {
    await commands.handleSlashCommand("/new notes:2026");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal("agentId" in body, false, "no agent is inferred from a path");
    assert.equal(body.cwd, "/work/notes:2026");
  });

  it("reads the same text as a coordinate once that agent exists", async () => {
    directory.installAgentDirectory(
      [
        { id: "pi", available: true },
        { id: "notes", available: true },
      ],
      "pi",
    );
    await commands.handleSlashCommand("/new notes:2026");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal(body.agentId, "notes");
    assert.equal(body.cwd, "/work/2026");
  });

  it("reports a typo'd prefix as a directory error, never as an agent", async () => {
    handler = (url, init) => {
      if (url.startsWith("/api/v1/files/info?")) {
        return json({ error: "not found" }, 404);
      }
      return defaultHandler(url, init);
    };
    await commands.handleSlashCommand("/new copliot:missing");
    const text = lines().join("\n");
    assert.match(text, /directory not found: 'copliot:missing'/);
    assert.doesNotMatch(text, /not configured|未配置/);
    assert.equal(
      calls.some((call) => call.url === "/api/v1/tasks"),
      false,
      "a missing directory never reaches create",
    );
  });

  it("accepts a typo'd prefix as a path when the directory exists", async () => {
    await commands.handleSlashCommand("/new copliot:rel");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal("agentId" in body, false);
    assert.equal(body.cwd, "/work/copliot:rel");
  });

  it("offers a rescue line when the named agent will not start", async () => {
    handler = (url, init) => {
      if (url.endsWith("/clear") && init?.method === "POST") {
        return json(
          { error: "Agent copilot is not available: handshake failed" },
          503,
        );
      }
      return defaultHandler(url, init);
    };
    await commands.handleSlashCommand("/clear copilot:");
    const text = lines().join("\n");
    assert.match(
      text,
      /Failed to clear task — Agent copilot is not available: handshake failed/,
    );
    assert.match(
      text,
      /\/clear pi:\/work/,
      "names a live agent and the raw cwd",
    );
  });

  it("offers the same rescue when a create fails to start", async () => {
    handler = (url, init) => {
      if (url === "/api/v1/tasks" && init?.method === "POST") {
        return json({ error: "Agent copilot is not available: nope" }, 503);
      }
      return defaultHandler(url, init);
    };
    await commands.handleSlashCommand("/new copilot:");
    await settle();
    const text = lines().join("\n");
    assert.match(
      text,
      /err: create failed — Agent copilot is not available: nope/,
    );
    assert.match(text, /\/clear pi:\/work/);
  });

  it("names the configured default when nothing else is available", async () => {
    directory.installAgentDirectory(
      [
        { id: "pi", available: false },
        { id: "copilot", available: true },
      ],
      "pi",
    );
    handler = (url, init) => {
      if (url.endsWith("/clear") && init?.method === "POST") {
        return json({ error: "Agent copilot is not available: nope" }, 503);
      }
      return defaultHandler(url, init);
    };
    await commands.handleSlashCommand("/clear copilot:");
    assert.match(lines().join("\n"), /\/clear pi:\/work/);
  });

  it("reports only the reason when there is nothing to rescue to", async () => {
    directory.installAgentDirectory([{ id: "pi", available: false }], "pi");
    handler = (url, init) => {
      if (url.endsWith("/clear") && init?.method === "POST") {
        return json({ error: "Agent pi is not available: nope" }, 503);
      }
      return defaultHandler(url, init);
    };
    await commands.handleSlashCommand("/clear pi:");
    const text = lines().join("\n");
    assert.match(
      text,
      /Failed to clear task — Agent pi is not available: nope/,
    );
    assert.doesNotMatch(text, /\/clear pi:/);
  });

  it("does not offer a rescue for an unconfigured agent", async () => {
    handler = (url, init) => {
      if (url.endsWith("/clear") && init?.method === "POST") {
        return json({ error: "Agent ghost is not configured" }, 400);
      }
      return defaultHandler(url, init);
    };
    directory.installAgentDirectory(
      [
        { id: "pi", available: true },
        { id: "ghost", available: true },
      ],
      "pi",
    );
    await commands.handleSlashCommand("/clear ghost:");
    const text = lines().join("\n");
    assert.match(text, /Agent ghost is not configured/);
    assert.doesNotMatch(text, /\/clear pi:/);
  });
});
