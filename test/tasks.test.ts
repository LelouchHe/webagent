import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { ConfigOption, AgentEvent } from "../src/types.ts";
import { mockBridgeStubs } from "./fixtures.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: data });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Minimal mock bridge that returns a predictable task ID. */
function createMockBridge(nextId = "mock-task-1") {
  let idCounter = 0;
  const retireCalls: string[] = [];
  const configOptions: ConfigOption[] = [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "claude-sonnet",
      options: [{ value: "claude-sonnet", name: "Sonnet" }],
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      currentValue: "agent",
      options: [{ value: "agent", name: "Agent" }],
    },
    {
      type: "boolean",
      id: "allow_all",
      name: "Allow all",
      currentValue: false,
    },
  ];
  return {
    retireCalls,
    retireExecution: async (agentSessionId: string) => {
      retireCalls.push(agentSessionId);
    },
    ...mockBridgeStubs(),
    promptForText: async () => "summary of the current work",
    newSession: async (_cwd: string) => {
      idCounter++;
      return {
        sessionId: idCounter === 1 ? nextId : `mock-task-${idCounter}`,
        configOptions: [],
      };
    },
    loadSession: async (_taskId: string, _cwd: string) => ({
      taskId: _taskId,
      configOptions,
    }),
    setConfigOption: async (
      _taskId: string,
      configId: string,
      value: string | boolean,
    ) => {
      return configOptions.map((opt) => {
        if (opt.id !== configId) return opt;
        if ("options" in opt && typeof value === "string") {
          return { ...opt, currentValue: value };
        }
        if (opt.type === "boolean" && typeof value === "boolean") {
          return { ...opt, currentValue: value };
        }
        return opt;
      });
    },
  };
}

describe("Task REST API", () => {
  let store: Store;
  let tasks: TaskManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;
  let broadcastEvents: AgentEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-rest-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(tmpDir, "test-agent");
    tasks = new TaskManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();
    broadcastEvents = [];

    const handler = createRequestHandler({
      store,
      tasks,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: 10_485_760,
        cancel_timeout: 10_000,
      },
      sseManager: {
        broadcast: (event: AgentEvent) => {
          broadcastEvents.push(event);
        },
      } as any,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- POST /api/v1/tasks ---

  describe("POST /api/v1/tasks", () => {
    it("creates a task with default cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.match(body.id, /^[0-9a-f-]{36}$/);
      assert.equal(store.getAgentSessionId(body.id), "mock-task-1");
      assert.equal(body.cwd, tmpDir);
      assert.equal(
        body.title,
        body.id,
        "an unnamed task defaults its title to the stable task id",
      );
      assert.ok(Array.isArray(body.configOptions));
    });

    it("coalesces concurrent bootstrap requests into one task", async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          makeRequest(port, "POST", "/api/v1/tasks/bootstrap"),
        ),
      );

      assert.ok(responses.every((response) => response.status === 200));
      const bodies = responses.map((response) => JSON.parse(response.body));
      assert.equal(new Set(bodies.map((body) => body.id)).size, 1);
      assert.equal(store.listTasks().length, 1);
      assert.equal(
        broadcastEvents.filter((event) => event.type === "task_created").length,
        1,
      );
      assert.equal(
        broadcastEvents.find((event) => event.type === "task_created")
          ?.clientOpId,
        undefined,
      );
    });

    it("bootstrap reuses the current-agent task while explicit create does not", async () => {
      const first = await makeRequest(port, "POST", "/api/v1/tasks/bootstrap");
      const bootstrapId = JSON.parse(first.body).id;

      const second = await makeRequest(port, "POST", "/api/v1/tasks/bootstrap");
      assert.equal(JSON.parse(second.body).id, bootstrapId);

      const explicit = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      assert.notEqual(JSON.parse(explicit.body).id, bootstrapId);
      assert.equal(store.listTasks().length, 2);
    });

    it("bootstrap ignores tasks owned by another agent", async () => {
      const other = new Store(tmpDir, "other-agent");
      other.createTask("other-web", tmpDir, "auto", "other-agent-task");
      other.close();

      const response = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks/bootstrap",
      );
      const body = JSON.parse(response.body);

      assert.equal(response.status, 200);
      assert.notEqual(body.id, "other-web");
      assert.equal(store.listTasks().length, 1);
      assert.equal(store.getTask("other-web"), undefined);
    });

    describe("POST /api/v1/tasks/:id/cancel", () => {
      it("resends cancel while the agent prompt remains active", async () => {
        store.createTask("s-cancel", tmpDir);
        tasks.activePrompts.add("s-cancel");
        tasks.syncBusy("s-cancel", "p1");
        let cancelCalls = 0;
        mockBridge.cancel = async () => {
          cancelCalls++;
        };

        const first = await makeRequest(
          port,
          "POST",
          "/api/v1/tasks/s-cancel/cancel",
          "{}",
        );
        const second = await makeRequest(
          port,
          "POST",
          "/api/v1/tasks/s-cancel/cancel",
          "{}",
        );

        assert.equal(first.status, 202);
        assert.equal(second.status, 202);
        assert.equal(cancelCalls, 2);
        assert.equal(tasks.activePrompts.has("s-cancel"), true);
        assert.equal(
          tasks.state.getState("s-cancel").runtime.busy?.cancelStatus,
          "requested",
        );

        tasks.runningBashProcs.set("s-cancel", {} as any);
        tasks.syncBusy("s-cancel");
        assert.equal(
          tasks.state.getState("s-cancel").runtime.busy?.kind,
          "agent",
        );
        assert.equal(
          tasks.state.getState("s-cancel").runtime.busy?.cancelStatus,
          "requested",
        );
      });

      it("returns idempotent idle status when no work is active", async () => {
        store.createTask("s-idle", tmpDir);

        const res = await makeRequest(
          port,
          "POST",
          "/api/v1/tasks/s-idle/cancel",
          "{}",
        );

        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.body), {
          ok: true,
          status: "idle",
        });
      });

      it("does not attach a stale cancel to a replacement prompt", async () => {
        store.createTask("s-race", tmpDir);
        tasks.activePrompts.add("s-race");
        tasks.syncBusy("s-race");
        const oldPromptId =
          tasks.state.getState("s-race").runtime.busy?.promptId;
        let releaseCancel: (() => void) | undefined;
        mockBridge.cancel = () =>
          new Promise<void>((resolve) => {
            releaseCancel = resolve;
          });

        const cancelRequest = makeRequest(
          port,
          "POST",
          "/api/v1/tasks/s-race/cancel",
          "{}",
        );
        for (let i = 0; i < 10 && !releaseCancel; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(releaseCancel);
        tasks.activePrompts.delete("s-race");
        tasks.syncBusy("s-race");
        tasks.activePrompts.add("s-race");
        tasks.syncBusy("s-race");
        const newPromptId =
          tasks.state.getState("s-race").runtime.busy?.promptId;
        assert.notEqual(newPromptId, oldPromptId);

        releaseCancel();
        const res = await cancelRequest;

        assert.equal(res.status, 202);
        assert.equal(JSON.parse(res.body).status, "superseded");
        assert.equal(
          tasks.state.getState("s-race").runtime.busy?.cancelStatus ?? null,
          null,
        );
        assert.equal(
          tasks.state.getState("s-race").runtime.busy?.promptId,
          newPromptId,
        );
      });

      it("reports superseded when a replacement prompt is still reserved", async () => {
        store.createTask("s-reserved-race", tmpDir);
        tasks.activePrompts.add("s-reserved-race");
        tasks.syncBusy("s-reserved-race");
        let releaseCancel: (() => void) | undefined;
        mockBridge.cancel = () =>
          new Promise<void>((resolve) => {
            releaseCancel = resolve;
          });

        const cancelRequest = makeRequest(
          port,
          "POST",
          "/api/v1/tasks/s-reserved-race/cancel",
          "{}",
        );
        for (let i = 0; i < 10 && !releaseCancel; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(releaseCancel);
        tasks.activePrompts.delete("s-reserved-race");
        tasks.syncBusy("s-reserved-race");
        const replacementSubmission =
          tasks.reservePromptSubmission("s-reserved-race");
        assert.ok(replacementSubmission);

        releaseCancel();
        const res = await cancelRequest;

        assert.equal(res.status, 202);
        assert.equal(JSON.parse(res.body).status, "superseded");
        assert.equal(
          tasks.pendingPromptSubmissions.has("s-reserved-race"),
          true,
        );
        tasks.releasePromptSubmission("s-reserved-race", replacementSubmission);
      });

      it("cancels a prompt submission while task resume is pending", async () => {
        store.createTask("s-pending", tmpDir);
        let releaseResume!: () => void;
        let promptCalls = 0;
        mockBridge.loadSession = () =>
          new Promise((resolve) => {
            releaseResume = () => {
              resolve({ taskId: "s-pending", configOptions: [] });
            };
          });
        mockBridge.prompt = async () => {
          promptCalls++;
        };

        const promptRequest = makeRequest(
          port,
          "POST",
          "/api/v1/tasks/s-pending/prompt",
          JSON.stringify({ text: "do not run" }),
        );
        for (
          let i = 0;
          i < 10 && !tasks.pendingPromptSubmissions.has("s-pending");
          i++
        ) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(tasks.pendingPromptSubmissions.has("s-pending"), true);

        const cancelRes = await makeRequest(
          port,
          "POST",
          "/api/v1/tasks/s-pending/cancel",
          "{}",
        );
        assert.equal(cancelRes.status, 200);
        assert.equal(JSON.parse(cancelRes.body).status, "cancelled");

        releaseResume();
        const promptRes = await promptRequest;
        assert.equal(promptRes.status, 409);
        assert.equal(promptCalls, 0);
      });
    });

    it("creates a child task under an existing Root", async () => {
      store.ensureRootTask(tmpDir);

      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ parentId: "root" }),
      );

      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(store.getTask(body.id)?.parent_id, "root");
      assert.equal(body.parentId, "root");
    });

    it("rejects an unknown parent task with 400", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ parentId: "no-such-task" }),
      );

      assert.equal(res.status, 400);
      assert.match(res.body, /Parent task not found/);
      assert.equal(store.listTasks().length, 0);
    });

    it("creates a task with custom cwd", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ cwd: tmpDir }),
      );
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.cwd, tmpDir);
    });

    it("creates a task inheriting from another", async () => {
      // Create first task to inherit from
      const res1 = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const s1 = JSON.parse(res1.body);

      const res2 = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ inheritFromTaskId: s1.id }),
      );
      assert.equal(res2.status, 201);
      const s2 = JSON.parse(res2.body);
      assert.notEqual(s2.id, s1.id);
    });

    it("creates a task with source field", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ source: "user" }),
      );
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "user");
    });

    it("defaults source to auto", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "auto");
    });

    it("broadcasts task_created event", async () => {
      await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const created = broadcastEvents.find((e) => e.type === "task_created");
      assert.ok(created, "should broadcast task_created");
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/tasks", "not-json");
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid cwd", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ cwd: "/nonexistent/path/12345" }),
      );
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      // Create handler with no bridge
      const handler = createRequestHandler({
        store,
        tasks,
        getBridge: () => null,
        publicDir,
        dataDir: tmpDir,
        limits: {
          bash_output: 1_048_576,
          image_upload: 10_485_760,
          cancel_timeout: 10_000,
        },
        sseManager: { broadcast() {} } as any,
      });
      const s2 = http.createServer(handler);
      await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
      const p2 = (s2.address() as { port: number }).port;

      const res = await makeRequest(p2, "POST", "/api/v1/tasks", "{}");
      assert.equal(res.status, 503);

      await new Promise<void>((resolve) =>
        s2.close(() => {
          resolve();
        }),
      );
    });
  });

  // --- POST /api/v1/tasks/:id/clear ---

  describe("POST /api/v1/tasks/:id/clear", () => {
    it("keeps the WebAgent task id while rotating its ACP execution", async () => {
      store.createTask("s1", tmpDir, "auto", "agent-old");
      store.saveCompactSummary("s1", "old context");

      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks/s1/clear",
        "{}",
      );

      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "s1");
      assert.equal(store.listTasks().length, 1);
      assert.equal(store.getAgentSessionId("s1"), "mock-task-1");
      assert.equal(store.getTaskId("agent-old"), undefined);
      assert.equal(store.getPendingCompactSummary("s1"), null);
      assert.deepEqual(mockBridge.retireCalls, ["agent-old"]);
    });

    it("persists a clear request's replacement cwd on the stable task", async () => {
      store.createTask("s1", tmpDir, "auto", "agent-old");

      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks/s1/clear",
        JSON.stringify({ cwd: publicDir }),
      );

      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).cwd, publicDir);
      assert.equal(store.getTask("s1")?.cwd, publicDir);
    });

    it("compacts into a fresh ACP execution and defers the summary to the next prompt", async () => {
      store.createTask("s1", tmpDir, "auto", "agent-old");
      tasks.liveTasks.add("s1");
      let promptedText = "";
      mockBridge.prompt = async (_taskId: string, text: string) => {
        promptedText = text;
      };

      const compactRes = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks/s1/compact",
        "{}",
      );
      assert.equal(compactRes.status, 202);
      // Compaction runs as a background task; wait for the rotation itself
      // (bounded deadline, not event-loop turns) so slow CI runners never
      // observe the pre-rotation state.
      const deadline = Date.now() + 5000;
      while (
        store.getAgentSessionId("s1") !== "mock-task-1" &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(
        store.getPendingCompactSummary("s1"),
        "summary of the current work",
      );
      const publicList = JSON.parse(
        (await makeRequest(port, "GET", "/api/v1/tasks")).body,
      ) as Array<Record<string, unknown>>;
      assert.equal("pending_compact_summary" in publicList[0], false);
      assert.equal(store.getAgentSessionId("s1"), "mock-task-1");
      assert.ok(
        broadcastEvents.some(
          (event) =>
            event.type === "assistant_message" &&
            event.taskId === "s1" &&
            event.text === "summary of the current work",
        ),
      );
      assert.equal(tasks.getBusyKind("s1"), null);

      const promptRes = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks/s1/prompt",
        JSON.stringify({ text: "continue the work" }),
      );
      assert.equal(promptRes.status, 202);
      assert.match(promptedText, /previous execution summary/);
      assert.match(promptedText, /summary of the current work/);
      assert.match(promptedText, /continue the work/);
      assert.equal(store.getPendingCompactSummary("s1"), null);
      const userEvent = [...store.getEvents("s1")]
        .reverse()
        .find((event) => event.type === "user_message");
      assert.equal(JSON.parse(userEvent!.data).text, "continue the work");
    });
  });

  // --- GET /api/v1/tasks/:id ---

  describe("GET /api/v1/tasks/:id", () => {
    it("returns task detail for existing task", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "GET", `/api/v1/tasks/${id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, id);
      assert.equal(body.cwd, tmpDir);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("returns 404 for unknown task", async () => {
      const res = await makeRequest(port, "GET", "/api/v1/tasks/nonexistent");
      assert.equal(res.status, 404);
    });

    it("returns a task's parent relationship", async () => {
      store.createTask("root", tmpDir, "root", "agent-root");
      store.createTask("child", tmpDir, "auto", "agent-child", "root");

      const res = await makeRequest(port, "GET", "/api/v1/tasks/child");

      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).parentId, "root");
    });

    it("auto-resumes a non-live task", async () => {
      // Create a task directly in store (not in liveTasks)
      store.createTask("stored-only", tmpDir);

      const res = await makeRequest(port, "GET", "/api/v1/tasks/stored-only");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "stored-only");
      // Should now be live
      assert.ok(tasks.liveTasks.has("stored-only"));
    });

    it("does not continue an interrupted turn while restoring", async () => {
      store.createTask("interrupted", tmpDir);
      store.saveEvent(
        "interrupted",
        "user_message",
        { text: "perform a non-idempotent action" },
        { from_ref: "user" },
      );
      let promptCalls = 0;
      mockBridge.prompt = async () => {
        promptCalls++;
      };

      const res = await makeRequest(port, "GET", "/api/v1/tasks/interrupted");
      assert.equal(res.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.ok(tasks.liveTasks.has("interrupted"));
      assert.equal(promptCalls, 0);
      assert.equal(tasks.getBusyKind("interrupted"), null);
    });

    it("snapshot waits for command discovery during a warm-cache resume", async () => {
      store.createTask("stored-only", tmpDir);
      tasks.cachedConfigOptions.push({
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "claude-sonnet",
        options: [{ value: "claude-sonnet", name: "Sonnet" }],
      });
      mockBridge.loadSession = async (taskId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        tasks.updateAgentCommands(taskId, [
          { name: "context", description: "Show context usage" },
        ]);
        return { taskId, configOptions: [] };
      };

      const detail = await makeRequest(
        port,
        "GET",
        "/api/v1/tasks/stored-only",
      );
      assert.equal(detail.status, 200);
      const snapshot = await makeRequest(
        port,
        "GET",
        "/api/v1/tasks/stored-only/snapshot",
      );

      assert.deepEqual(JSON.parse(snapshot.body).agentCommands.commands, [
        { name: "context", description: "Show context usage" },
      ]);
    });
  });

  // --- DELETE /api/v1/tasks/:id ---

  describe("DELETE /api/v1/tasks/:id", () => {
    it("deletes an existing task", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "DELETE", `/api/v1/tasks/${id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), {
        taskId: id,
        parentId: null,
        reset: false,
      });

      // Verify deleted from store
      assert.equal(store.getTask(id), undefined);
    });

    it("broadcasts task_deleted with the requested task parent", async () => {
      store.ensureRootTask(tmpDir);
      store.bindAgentSession("root", "agent-root");
      store.createTask("parent", tmpDir, "auto", "agent-parent", "root");
      broadcastEvents.length = 0;

      const res = await makeRequest(port, "DELETE", "/api/v1/tasks/parent");
      assert.equal(res.status, 200);
      const deleted = broadcastEvents.find(
        (e) => e.type === "task_deleted" && e.taskId === "parent",
      );
      assert.ok(deleted, "should broadcast task_deleted");
      /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrowing after assert.ok */
      if (deleted?.type === "task_deleted") {
        assert.equal(deleted.parentId, "root");
      }
      assert.deepEqual(JSON.parse(res.body), {
        taskId: "parent",
        parentId: "root",
        reset: false,
      });
    });

    it("returns 404 for unknown task", async () => {
      const res = await makeRequest(
        port,
        "DELETE",
        "/api/v1/tasks/nonexistent",
      );
      assert.equal(res.status, 404);
    });

    it("resets Root, deletes its descendants, and keeps Root as the anchor", async () => {
      store.ensureRootTask(tmpDir);
      store.bindAgentSession("root", "agent-root");
      store.createTask("child", tmpDir, "auto", "agent-child", "root");
      store.saveEvent(
        "root",
        "user_message",
        { text: "old root" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "child",
        "user_message",
        { text: "child" },
        { from_ref: "user" },
      );
      tasks.liveTasks.add("child");
      broadcastEvents.length = 0;

      const res = await makeRequest(port, "DELETE", "/api/v1/tasks/root");

      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { taskId: "root", reset: true });
      assert.equal(store.getTask("root")?.id, "root");
      assert.equal(store.getTaskIncludingDeleted("child"), undefined);
      assert.deepEqual(store.getEvents("root"), []);
      assert.ok(
        broadcastEvents.some(
          (event) => event.type === "task_deleted" && event.taskId === "child",
        ),
      );
      assert.ok(
        broadcastEvents.some(
          (event) => event.type === "task_reset" && event.taskId === "root",
        ),
      );
      assert.ok(mockBridge.retireCalls.includes("agent-root"));
      assert.ok(mockBridge.retireCalls.includes("agent-child"));
    });

    it("cascades to descendant tasks and broadcasts task_deleted per id", async () => {
      store.createTask("parent", tmpDir, "auto", "agent-parent");
      store.createTask("child", tmpDir, "auto", "agent-child", "parent");
      tasks.liveTasks.add("parent");
      tasks.liveTasks.add("child");

      const res = await makeRequest(port, "DELETE", "/api/v1/tasks/parent");

      assert.equal(res.status, 200);
      assert.equal(store.getTaskIncludingDeleted("parent"), undefined);
      assert.equal(store.getTaskIncludingDeleted("child"), undefined);
      const deletedEvents = broadcastEvents.filter(
        (event) => event.type === "task_deleted",
      );
      assert.deepEqual(deletedEvents.map((event) => event.taskId).sort(), [
        "child",
        "parent",
      ]);
      assert.deepEqual(mockBridge.retireCalls.sort(), [
        "agent-child",
        "agent-parent",
      ]);
      assert.deepEqual(JSON.parse(res.body), {
        taskId: "parent",
        parentId: null,
        reset: false,
      });
      assert.ok(!tasks.liveTasks.has("child"));
    });

    it("rejects deletion when a descendant has active work", async () => {
      store.createTask("parent", tmpDir, "auto", "agent-parent");
      store.createTask("child", tmpDir, "auto", "agent-child", "parent");
      tasks.activePrompts.add("child");
      tasks.syncBusy("child");

      const res = await makeRequest(port, "DELETE", "/api/v1/tasks/parent");

      assert.equal(res.status, 409);
      assert.equal(store.getTask("parent")?.id, "parent");
      assert.equal(store.getTask("child")?.id, "child");
    });

    it("rejects deletion while prompt work is active", async () => {
      store.createTask("s-active-delete", tmpDir);
      tasks.activePrompts.add("s-active-delete");
      tasks.syncBusy("s-active-delete");

      const res = await makeRequest(
        port,
        "DELETE",
        "/api/v1/tasks/s-active-delete",
      );

      assert.equal(res.status, 409);
      assert.equal(store.getTask("s-active-delete")?.id, "s-active-delete");
    });

    it("rejects deletion while prompt submission is pending", async () => {
      store.createTask("s-pending-delete", tmpDir);
      assert.notEqual(tasks.reservePromptSubmission("s-pending-delete"), null);

      const res = await makeRequest(
        port,
        "DELETE",
        "/api/v1/tasks/s-pending-delete",
      );

      assert.equal(res.status, 409);
      assert.equal(store.getTask("s-pending-delete")?.id, "s-pending-delete");
    });
  });

  // --- PUT /api/v1/tasks/:id/:configId ---

  describe("PUT /api/v1/tasks/:id/:configId", () => {
    it("updates model config", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/tasks/${id}/model`,
        JSON.stringify({ value: "claude-haiku" }),
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("updates mode config", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/tasks/${id}/mode`,
        JSON.stringify({ value: "agent#autopilot" }),
      );
      assert.equal(res.status, 200);
    });

    it("updates arbitrary boolean config via /config/:configId", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/tasks/${id}/config/allow-all`,
        JSON.stringify({ value: true }),
      );

      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const allowAll = body.configOptions.find(
        (opt: ConfigOption) => opt.id === "allow_all",
      );
      assert.deepEqual(allowAll, {
        type: "boolean",
        id: "allow_all",
        name: "Allow all",
        currentValue: true,
      });
    });

    it("broadcasts config_option_update", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);
      broadcastEvents.length = 0;

      await makeRequest(
        port,
        "PUT",
        `/api/v1/tasks/${id}/model`,
        JSON.stringify({ value: "claude-haiku" }),
      );
      const update = broadcastEvents.find(
        (e) => e.type === "config_option_update",
      );
      assert.ok(update, "should broadcast config_option_update");
    });

    it("returns 404 for unknown task", async () => {
      const res = await makeRequest(
        port,
        "PUT",
        "/api/v1/tasks/nonexistent/model",
        JSON.stringify({ value: "x" }),
      );
      assert.equal(res.status, 404);
    });

    it("returns 400 for empty body", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/tasks/${id}/model`,
        "{}",
      );
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/tasks/${id}/model`,
        "not-json",
      );
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      store.createTask("no-bridge", tmpDir);
      const handler = createRequestHandler({
        store,
        tasks,
        getBridge: () => null,
        publicDir,
        dataDir: tmpDir,
        limits: {
          bash_output: 1_048_576,
          image_upload: 10_485_760,
          cancel_timeout: 10_000,
        },
        sseManager: { broadcast() {} } as any,
      });
      const s2 = http.createServer(handler);
      await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
      const p2 = (s2.address() as { port: number }).port;

      const res = await makeRequest(
        p2,
        "PUT",
        "/api/v1/tasks/no-bridge/model",
        JSON.stringify({ value: "x" }),
      );
      assert.equal(res.status, 503);

      await new Promise<void>((resolve) =>
        s2.close(() => {
          resolve();
        }),
      );
    });
  });

  // --- GET /api/v1/tasks with source filter ---

  describe("GET /api/v1/tasks?source=", () => {
    it("filters tasks by source", async () => {
      await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ source: "user" }),
      );
      await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ source: "auto" }),
      );

      const allRes = await makeRequest(port, "GET", "/api/v1/tasks");
      assert.equal(JSON.parse(allRes.body).length, 2);

      const userRes = await makeRequest(
        port,
        "GET",
        "/api/v1/tasks?source=user",
      );
      const userTasks = JSON.parse(userRes.body);
      assert.equal(userTasks.length, 1);
      assert.equal(userTasks[0].source, "user");

      const autoRes = await makeRequest(
        port,
        "GET",
        "/api/v1/tasks?source=auto",
      );
      const autoTasks = JSON.parse(autoRes.body);
      assert.equal(autoTasks.length, 1);
      assert.equal(autoTasks[0].source, "auto");
    });

    it("returns all tasks without source filter", async () => {
      await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ source: "user" }),
      );
      await makeRequest(port, "POST", "/api/v1/tasks", "{}");

      const res = await makeRequest(port, "GET", "/api/v1/tasks");
      assert.equal(JSON.parse(res.body).length, 2);
    });
  });

  describe("gzip compression", () => {
    function makeRawRequest(
      innerPort: number,
      method: string,
      path: string,
      extraHeaders?: Record<string, string>,
    ): Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      rawBody: Buffer;
    }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: innerPort,
            path,
            method,
            headers: { "Content-Type": "application/json", ...extraHeaders },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                rawBody: Buffer.concat(chunks),
              });
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    it("returns gzip-compressed events when Accept-Encoding includes gzip", async () => {
      // Create task and add enough events to exceed 1KB threshold
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      const longText = "A".repeat(2000);
      store.saveEvent(
        taskId,
        "assistant_message",
        { text: longText },
        { from_ref: "agent" },
      );

      const res = await makeRawRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
        {
          "Accept-Encoding": "gzip",
        },
      );

      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], "gzip");
      // Gzipped body should be smaller than uncompressed
      const uncompressed = await makeRawRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
      );
      assert.ok(
        res.rawBody.length < uncompressed.rawBody.length,
        "gzipped response should be smaller",
      );

      // Verify it decompresses to valid JSON
      const { gunzipSync } = await import("node:zlib");
      const decompressed = gunzipSync(res.rawBody);
      const body = JSON.parse(decompressed.toString());
      assert.ok(Array.isArray(body.events));
      assert.ok(body.events.length >= 1);
    });

    it("returns uncompressed when Accept-Encoding is absent", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      store.saveEvent(
        taskId,
        "assistant_message",
        { text: "B".repeat(2000) },
        { from_ref: "agent" },
      );

      const res = await makeRawRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
      );

      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], undefined);
      const body = JSON.parse(res.rawBody.toString());
      assert.ok(Array.isArray(body.events));
    });

    it("skips gzip for small responses under 1KB", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      store.saveEvent(
        taskId,
        "assistant_message",
        { text: "tiny" },
        { from_ref: "agent" },
      );

      const res = await makeRawRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
        {
          "Accept-Encoding": "gzip",
        },
      );

      assert.equal(res.status, 200);
      assert.equal(
        res.headers["content-encoding"],
        undefined,
        "should not gzip small payloads",
      );
    });
  });

  describe("streaming buffer flush on events endpoint", () => {
    it("flushes pending thinking buffer and signals streaming", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      // Simulate agent mid-thinking: buffer has unflushed content
      tasks.appendThinking(taskId, "partial thought");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
      );
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, true);
      assert.equal(body.streaming.assistant, false);
      // The flushed thinking event should be in the events list
      const thinkingEvt = body.events.find(
        (e: { type: string }) => e.type === "thinking",
      );
      assert.ok(thinkingEvt, "should include flushed thinking event");
      const data = JSON.parse(thinkingEvt.data);
      assert.equal(data.text, "partial thought");
      // Buffer should be empty after flush
      assert.equal(tasks.thinkingBuffers.has(taskId), false);
    });

    it("flushes pending assistant buffer and signals streaming", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      tasks.appendAssistant(taskId, "partial reply");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
      );
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, false);
      assert.equal(body.streaming.assistant, true);
      const msgEvt = body.events.find(
        (e: { type: string }) => e.type === "assistant_message",
      );
      assert.ok(msgEvt, "should include flushed assistant_message event");
      assert.equal(tasks.assistantBuffers.has(taskId), false);
    });

    it("returns streaming false when no buffers are pending", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      store.saveEvent(
        taskId,
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
      );
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, false);
      assert.equal(body.streaming.assistant, false);
    });

    it("does not signal streaming for empty buffers", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      tasks.assistantBuffers.set(taskId, "");
      tasks.thinkingBuffers.set(taskId, "");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
      );
      const body = JSON.parse(res.body);

      assert.deepEqual(body.streaming, {
        thinking: false,
        assistant: false,
      });
      assert.equal(tasks.assistantBuffers.has(taskId), false);
      assert.equal(tasks.thinkingBuffers.has(taskId), false);
    });

    it("keeps an active stream open when its pending buffer is empty", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/tasks", "{}");
      const taskId = JSON.parse(createRes.body).id;
      store.saveEvent(
        taskId,
        "user_message",
        { text: "question" },
        { from_ref: "user" },
      );
      store.saveEvent(
        taskId,
        "assistant_message",
        { text: "partial reply" },
        { from_ref: "agent" },
      );
      tasks.assistantBuffers.set(taskId, "");
      tasks.state.patch(taskId, {
        runtime: {
          streaming: { thinking: false, assistant: true },
        },
      });

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/events`,
      );
      const body = JSON.parse(res.body);

      assert.deepEqual(body.streaming, {
        thinking: false,
        assistant: true,
      });
      assert.equal(tasks.assistantBuffers.has(taskId), false);
    });
  });
});
