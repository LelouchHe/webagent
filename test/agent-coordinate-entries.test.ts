import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The three entries that accept a coordinate — `+`, `/new`, `/clear` — share
 * one parse and one set of wire semantics.
 *
 * An empty suffix means the directory the submitting task runs in on every
 * entry: the creates state it on the wire (`+` and `/new` send the cwd), and
 * `/clear` omits the field, which the server reads as "keep the directory".
 * The directory is one value; only the request shape differs, because an
 * omitted `cwd` on create would mean the server default instead.
 */

interface Call {
  url: string;
  init?: { method?: string; body?: string };
}

describe("coordinate entries", () => {
  let state: any;
  let dom: any;
  let createNewTaskRequest: (options?: any) => Promise<boolean>;
  let commands: any;
  let taskCommand: any;
  let directory: any;
  let calls: Call[];
  let handler: (
    url: string,
    init?: any,
  ) => Response | Promise<Response> | undefined;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    createNewTaskRequest = stateMod.createNewTaskRequest;
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
    directory.installAgentDirectory([{ id: "pi" }, { id: "copilot" }], "pi");
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
      const response = await handler(url, init);
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
    if (url.startsWith("/api/v1/recent-paths")) {
      return json([]);
    }
    return undefined;
  }

  /** The menu's action row for the current input, activated like a click. */
  async function clickFirstMenuRow(): Promise<void> {
    commands.updateSlashMenu();
    await settle();
    const row = dom.slashMenu.querySelector(".slash-item");
    assert.ok(row, `expected an action row; got ${dom.slashMenu.textContent}`);
    row.dispatchEvent(
      new (globalThis.window as any).MouseEvent("mousedown", { bubbles: true }),
    );
    await settle();
  }

  function projection(body: any): { agentId: unknown; cwd: unknown } {
    return { agentId: body.agentId, cwd: body.cwd };
  }

  function bodyOf(method: string, suffix: string, exact = false): any {
    const call = calls.find(
      (entry) =>
        (exact ? entry.url === suffix : entry.url.endsWith(suffix)) &&
        entry.init?.method === method,
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

  it("/new creates in the task directory for an empty suffix", async () => {
    await commands.handleSlashCommand("/new copilot:");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal(body.agentId, "copilot");
    // Same directory as `/new` with no path at all: the coordinate changes the
    // agent, never where the task runs.
    assert.equal(body.cwd, "/work");
    assert.equal(body.parentId, "old-1");
    assert.equal(body.inheritFromTaskId, "old-1");
  });

  it("a coordinate create and a bare create state the same directory", async () => {
    await commands.handleSlashCommand("/new");
    await settle();
    const bare = bodyOf("POST", "/api/v1/tasks", true);

    calls = [];
    await commands.handleSlashCommand("/new copilot:");
    await settle();
    const coordinate = bodyOf("POST", "/api/v1/tasks", true);

    assert.equal(coordinate.cwd, bare.cwd);
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
      { command: "/clear copilot:", cwd: null },
      { command: "/new copilot:", cwd: "/work" },
      { command: "+fix copilot:", cwd: "/work" },
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
      if (input.cwd === null) {
        // `/clear` keeps the directory by omitting the field; the creates say
        // the same directory explicitly.
        assert.equal("cwd" in body, false, `${input.command} omits the field`);
      } else {
        assert.equal(body.cwd, input.cwd, input.command);
      }
    }
  });

  it("/clear action row and Enter submit the same projection", async () => {
    await commands.handleSlashCommand("/clear copilot:rel");
    const enterBody = bodyOf("POST", "/clear");

    calls = [];
    dom.input.value = "/clear copilot:rel";
    await clickFirstMenuRow();
    const clickBody = bodyOf("POST", "/clear");

    assert.deepEqual(projection(clickBody), projection(enterBody));
    assert.deepEqual(projection(clickBody), {
      agentId: "copilot",
      cwd: "/work/rel",
    });
  });

  it("/new action row and Enter submit the same projection", async () => {
    await commands.handleSlashCommand("/new copilot:rel");
    await settle();
    const enterBody = bodyOf("POST", "/api/v1/tasks", true);

    calls = [];
    dom.input.value = "/new copilot:rel";
    await clickFirstMenuRow();
    const clickBody = bodyOf("POST", "/api/v1/tasks", true);

    assert.deepEqual(projection(clickBody), projection(enterBody));
    assert.deepEqual(projection(clickBody), {
      agentId: "copilot",
      cwd: "/work/rel",
    });
  });

  it("/clear with an empty coordinate suffix sends no cwd at all", async () => {
    await commands.handleSlashCommand("/clear copilot:");
    const body = bodyOf("POST", "/clear");
    assert.equal(body.agentId, "copilot");
    assert.equal("cwd" in body, false, "the server owns the task directory");
  });

  it("treats outer whitespace as the separator, never as a path byte", async () => {
    // Interior bytes are the path.
    await commands.handleSlashCommand("/new copilot:~/a  b");
    await settle();
    assert.equal(bodyOf("POST", "/api/v1/tasks", true).cwd, "~/a  b");

    // A trailing separator is not part of the directory name.
    calls = [];
    await commands.handleSlashCommand("/new copilot:~/a ");
    await settle();
    assert.equal(bodyOf("POST", "/api/v1/tasks", true).cwd, "~/a");

    // `copilot: ` is the same request as `copilot:`: the suffix is empty.
    calls = [];
    await commands.handleSlashCommand("/new copilot: ");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks", true);
    assert.equal(body.agentId, "copilot");
    assert.equal(body.cwd, "/work");
  });

  it("treats an unconfigured prefix as a path", async () => {
    await commands.handleSlashCommand("/new notes:2026");
    await settle();
    const body = bodyOf("POST", "/api/v1/tasks");
    assert.equal("agentId" in body, false, "no agent is inferred from a path");
    assert.equal(body.cwd, "/work/notes:2026");
  });

  it("reads the same text as a coordinate once that agent exists", async () => {
    directory.installAgentDirectory([{ id: "pi" }, { id: "notes" }], "pi");
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

  it("does not install a superseded bootstrap's agent directory", async () => {
    directory.installAgentDirectory([{ id: "current" }], "current");
    let releaseBootstrap!: (response: Response) => void;
    handler = (url, init) => {
      if (url === "/api/v1/tasks/bootstrap" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          releaseBootstrap = resolve;
        });
      }
      return defaultHandler(url, init);
    };

    const pending = createNewTaskRequest({
      bootstrap: true,
      inheritFromTaskId: null,
    });
    await settle();
    // A navigation supersedes the bootstrap while its response is pending.
    state.taskSwitchGen += 1;
    releaseBootstrap(
      json({
        id: "root",
        rootTaskId: "root",
        cwd: "/work",
        configOptions: [],
        agents: [{ id: "ghost" }],
        defaultAgentId: "ghost",
      }),
    );
    await pending;

    assert.deepEqual(
      directory.getAgentDirectory().ids,
      ["current"],
      "a superseded request must not install metadata",
    );
    assert.equal(directory.getDefaultAgentId(), "current");
  });

  it("reports a late create failure with the submitting agent and directory", async () => {
    directory.installAgentDirectory(
      [{ id: "mock" }, { id: "copilot" }],
      "mock",
    );
    state.taskAgentId = "mock";
    let releaseCreate!: (response: Response) => void;
    handler = (url, init) => {
      if (url === "/api/v1/tasks" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          releaseCreate = resolve;
        });
      }
      return defaultHandler(url, init);
    };

    // The submitting task runs on copilot; the configured default (mock) is a
    // different agent, so it is the rescue's only candidate.
    state.taskAgentId = "copilot";
    const pending = taskCommand.executeTaskCommand("+t");
    await settle();
    // The view moves to another task while the create is still in flight.
    state.taskId = "other";
    state.taskAgentId = "mock";
    state.taskCwd = "/other";
    releaseCreate(json({ error: "Agent copilot is not available: nope" }, 503));
    await pending;

    const text = lines().join("\n");
    assert.match(
      text,
      /err: create failed — Agent copilot is not available: nope/,
    );
    // Submission-time agent (excluded from the rescue) and directory.
    assert.match(text, /\/clear mock:\/work/);
    assert.doesNotMatch(text, /\/other/);
  });

  it("reports a late clear failure with the submitting agent and directory", async () => {
    directory.installAgentDirectory(
      [{ id: "mock" }, { id: "copilot" }],
      "mock",
    );
    state.taskAgentId = "mock";
    let releaseClear!: (response: Response) => void;
    handler = (url, init) => {
      if (url.endsWith("/clear") && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          releaseClear = resolve;
        });
      }
      return defaultHandler(url, init);
    };

    const pending = commands.handleSlashCommand("/clear copilot:");
    await settle();
    state.taskId = "other";
    state.taskAgentId = "mock";
    state.taskCwd = "/other";
    releaseClear(json({ error: "Agent copilot is not available: nope" }, 503));
    await pending;

    const text = lines().join("\n");
    assert.match(
      text,
      /Failed to clear task — Agent copilot is not available: nope/,
    );
    assert.match(text, /\/clear mock:\/work/);
    assert.doesNotMatch(text, /\/other/);
  });

  it("does not rescue onto the agent the server actually tried", async () => {
    // An implicit target is chosen by the server: an unbound task, or one whose
    // binding left the configuration, resolves to the configured default. The
    // client's submission-time guess is null/removed, so a rescue built from it
    // would point straight back at the agent that just failed.
    const failure = (agentId: string) =>
      json(
        { error: `Agent ${agentId} is not available: spawn failed`, agentId },
        503,
      );

    // `/new` from a task with no binding.
    state.taskAgentId = null;
    handler = (url, init) =>
      url === "/api/v1/tasks" && init?.method === "POST"
        ? failure("pi")
        : defaultHandler(url, init);
    await commands.handleSlashCommand("/new");
    await settle();
    let text = lines().join("\n");
    assert.match(text, /err: create failed — Agent pi is not available/);
    assert.doesNotMatch(
      text,
      /\/clear pi:/,
      "not back onto the failed default",
    );

    // `+` from a task whose binding is no longer configured.
    calls = [];
    state.taskId = "old-1";
    state.taskAgentId = "removed";
    handler = (url, init) =>
      url === "/api/v1/tasks" && init?.method === "POST"
        ? failure("pi")
        : defaultHandler(url, init);
    await taskCommand.executeTaskCommand("+next");
    await settle();
    text = lines().join("\n");
    assert.match(text, /Agent pi is not available/);
    assert.doesNotMatch(text, /\/clear pi:/);

    // `/clear` with the same removed binding.
    calls = [];
    state.taskId = "old-1";
    state.taskAgentId = "removed";
    handler = (url, init) =>
      url.endsWith("/clear") && init?.method === "POST"
        ? failure("pi")
        : defaultHandler(url, init);
    await commands.handleSlashCommand("/clear");
    await settle();
    text = lines().join("\n");
    assert.match(text, /Failed to clear task — Agent pi is not available/);
    assert.doesNotMatch(text, /\/clear pi:/);
  });

  it("keeps the rescue when the failed target is not the default", async () => {
    // The server's agent id is also what makes the *explicit* paths safe: the
    // default is a different agent, so the one-line rescue still appears.
    handler = (url, init) =>
      url.endsWith("/clear") && init?.method === "POST"
        ? json(
            {
              error: "Agent copilot is not available: handshake failed",
              agentId: "copilot",
            },
            503,
          )
        : defaultHandler(url, init);
    await commands.handleSlashCommand("/clear copilot:");
    const text = lines().join("\n");
    assert.match(text, /Failed to clear task — Agent copilot is not available/);
    assert.match(text, /\/clear pi:\/work/);
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

  it("names the configured default when the target fails", async () => {
    directory.installAgentDirectory([{ id: "pi" }, { id: "copilot" }], "pi");
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
    directory.installAgentDirectory([{ id: "pi" }], "pi");
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
    directory.installAgentDirectory([{ id: "pi" }, { id: "ghost" }], "pi");
    await commands.handleSlashCommand("/clear ghost:");
    const text = lines().join("\n");
    assert.match(text, /Agent ghost is not configured/);
    assert.doesNotMatch(text, /\/clear pi:/);
  });
});
