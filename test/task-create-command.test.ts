import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * `+` is the title-first create command: the first shell word is the title and
 * the verbatim remainder is the child cwd. Creation never switches tasks, so
 * the first instruction can follow as a separate `@<title> <body>` send.
 */
describe("+ title-first create", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let taskCommand: any;
  let fetchCalls: Array<{ url: string; init?: any }>;
  let existingDirs: Set<string>;
  let listEntries: Array<{
    name: string;
    kind: string;
    size: null;
    mtime: number;
  }>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
    taskCommand = await import("../public/js/task-command.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    fetchCalls = [];
    existingDirs = new Set(["/work", "/work/rel", "/tmp/with space", "~/x"]);
    listEntries = [{ name: "public", kind: "dir", size: null, mtime: 1 }];
    state.clientId = "cl-1";
    state.taskId = "s1";
    state.taskCwd = "/work";
    state.taskCwdDisplay = "~/work";
    globalThis.fetch = (async (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      fetchCalls.push({ url, init });
      if (url.startsWith("/api/v1/files/info?")) {
        const path = decodeURIComponent(
          url.slice("/api/v1/files/info?path=".length),
        );
        if (!existingDirs.has(path)) {
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
          });
        }
        return new Response(
          JSON.stringify({
            path,
            pathDisplay: path === "/work" ? "~/work" : path,
            name: "x",
            kind: "dir",
            size: 0,
            mtime: 1,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/v1/files/list?")) {
        return new Response(
          JSON.stringify({
            path: "/work",
            pathDisplay: "~/work",
            parent: "/",
            truncated: false,
            entries: listEntries,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/v1/recent-paths")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url === "/api/v1/tasks" && init?.method === "POST") {
        const body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: "child-1",
            title: body.title,
            cwd: body.cwd,
            cwdDisplay: body.cwd,
          }),
          { status: 201 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as any;
  });

  function messageLines(): string[] {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  function createCall(): { url: string; init: any } | undefined {
    const found = fetchCalls.find(
      (c) => c.url === "/api/v1/tasks" && c.init?.method === "POST",
    );
    return found ? { url: found.url, init: found.init } : undefined;
  }

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 10));
  }

  // --- execution ---

  it("reports a missing title for a bare + instead of creating", async () => {
    await taskCommand.executeTaskCommand("+");

    assert.ok(
      messageLines().some((l) =>
        l.includes("err: Task title is required after +"),
      ),
      `expected missing-title error, got: ${JSON.stringify(messageLines())}`,
    );
    assert.equal(createCall(), undefined, "bare + must not create a task");
  });

  it("creates a titled child in the current cwd without switching", async () => {
    await taskCommand.executeTaskCommand("+api-fix");

    const call = createCall();
    assert.ok(call, "expected POST /api/v1/tasks");
    assert.deepEqual(JSON.parse(call.init.body), {
      parentId: "s1",
      cwd: "/work",
      title: "api-fix",
      inheritFromTaskId: "s1",
    });
    assert.ok(
      messageLines().some((l) => l.includes("Created api-fix at /work")),
      `expected created line, got: ${JSON.stringify(messageLines())}`,
    );
    assert.ok(
      messageLines().some((l) =>
        l.includes("Send its first instruction with @api-fix <message>"),
      ),
      "expected the @<title> handoff hint",
    );
    // Creation is idle and keeps the user on the launching task.
    assert.equal(state.taskId, "s1");
    assert.equal(location.hash, "");
  });

  it("rejects a title containing '/' before touching the filesystem", async () => {
    await taskCommand.executeTaskCommand("+public/api-fix");

    assert.ok(
      messageLines().some((l) => l.includes("Task title cannot contain '/'")),
      `expected title error, got: ${JSON.stringify(messageLines())}`,
    );
    assert.equal(createCall(), undefined);
    assert.equal(
      fetchCalls.some((c) => c.url.startsWith("/api/v1/files/info?")),
      false,
      "an invalid title must not probe the filesystem",
    );
  });

  it("resolves a relative cwd against the current task cwd", async () => {
    await taskCommand.executeTaskCommand("+api-fix ./rel");

    assert.ok(
      fetchCalls.some((c) =>
        c.url.includes(
          `/api/v1/files/info?path=${encodeURIComponent("/work/rel")}`,
        ),
      ),
      `expected ./rel resolved to /work/rel, got: ${JSON.stringify(
        fetchCalls.map((c) => c.url),
      )}`,
    );
    const call = createCall();
    assert.ok(call);
    assert.equal(JSON.parse(call.init.body).cwd, "/work/rel");
  });

  it("keeps a cwd with spaces verbatim and unquoted", async () => {
    await taskCommand.executeTaskCommand("+api-fix /tmp/with space");

    assert.ok(
      fetchCalls.some((c) =>
        c.url.includes(
          `/api/v1/files/info?path=${encodeURIComponent("/tmp/with space")}`,
        ),
      ),
      `expected the verbatim spaced cwd, got: ${JSON.stringify(
        fetchCalls.map((c) => c.url),
      )}`,
    );
    const call = createCall();
    assert.ok(call);
    assert.equal(JSON.parse(call.init.body).cwd, "/tmp/with space");
  });

  it("passes a ~ cwd through for the server to expand", async () => {
    await taskCommand.executeTaskCommand("+api-fix ~/x");

    const call = createCall();
    assert.ok(call);
    assert.equal(JSON.parse(call.init.body).cwd, "~/x");
  });

  it("refuses to create when the cwd does not exist", async () => {
    await taskCommand.executeTaskCommand("+api-fix /missing");

    assert.ok(
      messageLines().some((l) =>
        l.includes("err: create failed — directory not found: '/missing'"),
      ),
      `expected directory error, got: ${JSON.stringify(messageLines())}`,
    );
    assert.equal(createCall(), undefined, "must not create in a missing dir");
    assert.equal(state.taskId, "s1");
  });

  it("stops the old silent mis-split: '+my dir/t' errors on the cwd", async () => {
    await taskCommand.executeTaskCommand("+my dir/t");

    assert.ok(
      messageLines().some((l) => l.includes("directory not found: 'dir/t'")),
      `expected the cwd to be taken verbatim, got: ${JSON.stringify(
        messageLines(),
      )}`,
    );
    assert.equal(createCall(), undefined);
  });

  // --- menu ---

  it("shows only the syntax hint for a bare +", async () => {
    dom.input.value = "+";
    commands.updateSlashMenu();
    await settle();

    const row = dom.slashMenu.querySelector(".slash-item");
    assert.ok(row);
    assert.equal(
      row.querySelector(".slash-primary")?.textContent,
      "create task · type a title",
    );
    assert.equal(row.querySelector(".slash-secondary")?.textContent, undefined);
    assert.equal(row.querySelector(".slash-prefix")?.textContent, "");
    assert.doesNotMatch(dom.slashMenu.textContent, /create '/);
  });

  it("leads with the action preview row once a title is present", async () => {
    dom.input.value = "+api-fix";
    commands.updateSlashMenu();
    await settle();

    const rows = [...dom.slashMenu.querySelectorAll(".slash-item")];
    assert.equal(rows.length, 1, "no cwd rows before the separating space");
    // The default cwd is implicit, so it is not echoed back.
    assert.equal(
      rows[0].querySelector(".slash-primary")?.textContent,
      "create 'api-fix'",
    );
    assert.equal(rows[0].querySelector(".slash-prefix")?.textContent, "↵");
  });

  it("previews an explicit cwd with an at clause", async () => {
    dom.input.value = "+api-fix /tmp/x";
    commands.updateSlashMenu();
    await settle();

    const row = dom.slashMenu.querySelector(".slash-item");
    assert.ok(row);
    assert.equal(
      row.querySelector(".slash-primary")?.textContent,
      "create 'api-fix' at '/tmp/x'",
    );
  });

  it("renders a title containing a quote without fabricating an at clause", async () => {
    dom.input.value = `+"foo' at 'bar"`;
    commands.updateSlashMenu();
    await settle();

    const row = dom.slashMenu.querySelector(".slash-item");
    assert.ok(row);
    const primary = row.querySelector(".slash-primary")?.textContent;
    // One double-quoted field: the inner `at` is part of the title, not a cwd.
    assert.equal(primary, `create "foo' at 'bar"`);
    assert.notEqual(primary, "create 'foo' at 'bar'");
  });

  it("renders a cwd containing a quote without ambiguity", async () => {
    dom.input.value = `+api-fix /tmp/x'y`;
    commands.updateSlashMenu();
    await settle();

    const row = dom.slashMenu.querySelector(".slash-item");
    assert.ok(row);
    assert.equal(
      row.querySelector(".slash-primary")?.textContent,
      `create 'api-fix' at "/tmp/x'y"`,
    );
  });

  it("treats a whitespace-only title as missing", async () => {
    dom.input.value = `+"   "`;
    commands.updateSlashMenu();
    await settle();

    assert.equal(
      dom.slashMenu.querySelector(".slash-primary")?.textContent,
      "create task · type a title",
    );
    assert.doesNotMatch(dom.slashMenu.textContent, /create '/);

    await taskCommand.executeTaskCommand(`+"   "`);
    assert.ok(
      messageLines().some((l) =>
        l.includes("err: Task title is required after +"),
      ),
      `expected missing-title error, got: ${JSON.stringify(messageLines())}`,
    );
    assert.equal(createCall(), undefined);
  });

  it("lists cwd candidates only after the separating space", async () => {
    dom.input.value = "+api-fix ";
    commands.updateSlashMenu();
    await settle();

    const rows = [...dom.slashMenu.querySelectorAll(".slash-item")].map(
      (row: any) => ({
        primary: row.querySelector(".slash-primary")?.textContent,
        prefix: row.querySelector(".slash-prefix")?.textContent,
      }),
    );
    assert.equal(rows[0].primary, "create 'api-fix'");
    assert.deepEqual(rows[1], { primary: "~/work", prefix: "*" });
  });

  it("completes a cwd candidate without creating anything", async () => {
    dom.input.value = "+api-fix ";
    commands.updateSlashMenu();
    await settle();

    const current = [...dom.slashMenu.querySelectorAll(".slash-item")].find(
      (row: any) =>
        row.querySelector(".slash-primary")?.textContent === "~/work",
    );
    assert.ok(current, "expected the current cwd row");
    current.dispatchEvent(
      new (globalThis.window as any).MouseEvent("mousedown", { bubbles: true }),
    );
    await settle();

    assert.equal(dom.input.value, "+api-fix ~/work");
    assert.equal(createCall(), undefined, "completion must not create");
  });

  it("drills into a typed cwd prefix with a raw, unquoted fill", async () => {
    dom.input.value = "+api-fix pu";
    commands.updateSlashMenu();
    await settle();

    const row = [...dom.slashMenu.querySelectorAll(".slash-item")].find(
      (r: any) => r.querySelector(".slash-primary")?.textContent === "public",
    );
    assert.ok(row, "expected the public/ directory row");
    row.dispatchEvent(
      new (globalThis.window as any).MouseEvent("mousedown", { bubbles: true }),
    );
    await settle();

    assert.equal(dom.input.value, "+api-fix public/");
  });

  it("clicking the action row creates the previewed task", async () => {
    dom.input.value = "+api-fix";
    commands.updateSlashMenu();
    await settle();

    const action = dom.slashMenu.querySelector(".slash-item");
    action.dispatchEvent(
      new (globalThis.window as any).MouseEvent("mousedown", { bubbles: true }),
    );
    await settle();

    const call = createCall();
    assert.ok(call, "the action row must create on click");
    assert.equal(JSON.parse(call.init.body).title, "api-fix");
  });
});
