import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { ConfigOption } from "../src/types.ts";
import { mockBridgeStubs } from "./fixtures.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json", ...extraHeaders },
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

function createMockBridge() {
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
  ];
  let idCounter = 0;
  return {
    ...mockBridgeStubs(),
    newSession: async (_cwd: string) => {
      idCounter++;
      return { sessionId: `mock-task-${idCounter}`, configOptions: [] };
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
      return configOptions.map((opt) =>
        opt.id === configId && "options" in opt && typeof value === "string"
          ? { ...opt, currentValue: value }
          : opt,
      );
    },
    cancel: async (_taskId: string) => {},
    prompt: async (_taskId: string, _text: string, _images?: unknown[]) => {},
    resolvePermission: async (_requestId: string, _optionId: string) => {},
    denyPermission: async (_requestId: string) => {},
  };
}

describe("Operations REST API", () => {
  let store: Store;
  let tasks: TaskManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-ops-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(join(tmpDir, "test.db"), "test-agent");
    tasks = new TaskManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();

    const handler = createRequestHandler({
      store,
      tasks,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024, cancel_timeout: 10000 },
      sseManager: { broadcast() {} } as any,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to create a task and return its ID
  async function createTask(): Promise<string> {
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/tasks",
      JSON.stringify({ cwd: tmpDir }),
    );
    return JSON.parse(res.body).id;
  }

  describe("POST /api/v1/tasks/:id/cancel", () => {
    it("cancels an active prompt", async () => {
      const taskId = await createTask();
      tasks.activePrompts.add(taskId);
      tasks.syncBusy(taskId);

      let cancelCalled = false;
      mockBridge.cancel = async () => {
        cancelCalled = true;
      };

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${taskId}/cancel`,
      );
      assert.equal(res.status, 202);
      assert.deepEqual(JSON.parse(res.body), {
        ok: true,
        status: "cancelling",
      });
      assert.ok(cancelCalled);
      assert.equal(tasks.activePrompts.has(taskId), true);
    });

    it("kills running bash process", async () => {
      const taskId = await createTask();
      // Create a fake child process with a kill method
      let killed = false;
      const fakeProc = new EventEmitter() as any;
      fakeProc.pid = 12345;
      fakeProc.kill = () => {
        killed = true;
        return true;
      };
      fakeProc.stdout = new EventEmitter();
      fakeProc.stderr = new EventEmitter();
      tasks.runningBashProcs.set(taskId, fakeProc);

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${taskId}/cancel`,
      );
      assert.equal(res.status, 202);
      assert.deepEqual(JSON.parse(res.body), {
        ok: true,
        status: "cancelling",
      });
      assert.ok(killed);
      assert.equal(tasks.runningBashProcs.has(taskId), true);
    });

    it("kills bash even when the agent bridge is unavailable", async () => {
      const taskId = await createTask();
      let killed = false;
      const fakeProc = new EventEmitter() as any;
      fakeProc.pid = 12346;
      fakeProc.kill = () => {
        killed = true;
        return true;
      };
      fakeProc.stdout = new EventEmitter();
      fakeProc.stderr = new EventEmitter();
      tasks.runningBashProcs.set(taskId, fakeProc);
      tasks.activePrompts.add(taskId);
      tasks.syncBusy(taskId);
      const handler = createRequestHandler({
        store,
        tasks,
        getBridge: () => null,
        publicDir,
        dataDir: tmpDir,
        limits: { bash_output: 1024, image_upload: 1024 },
        sseManager: { broadcast() {} } as any,
      });
      const srv = http.createServer(handler);
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
      const bashPort = (srv.address() as { port: number }).port;

      try {
        const res = await makeRequest(
          bashPort,
          "POST",
          `/api/v1/tasks/${taskId}/cancel`,
        );
        assert.equal(res.status, 503);
        assert.equal(killed, true);
      } finally {
        await new Promise<void>((resolve) =>
          srv.close(() => {
            resolve();
          }),
        );
      }
    });

    it("escalates repeated bash cancel from SIGINT to SIGKILL", async () => {
      const taskId = await createTask();
      const signals: string[] = [];
      const fakeProc = new EventEmitter() as any;
      fakeProc.kill = (signal: string) => {
        signals.push(signal);
        return true;
      };
      fakeProc.stdout = new EventEmitter();
      fakeProc.stderr = new EventEmitter();
      tasks.runningBashProcs.set(taskId, fakeProc);

      await makeRequest(port, "POST", `/api/v1/tasks/${taskId}/cancel`);
      await makeRequest(port, "POST", `/api/v1/tasks/${taskId}/cancel`);

      assert.deepEqual(signals, ["SIGINT", "SIGKILL"]);
      assert.equal(tasks.runningBashProcs.has(taskId), true);

      const replacementSignals: string[] = [];
      const replacementProc = new EventEmitter() as any;
      replacementProc.kill = (signal: string) => {
        replacementSignals.push(signal);
        return true;
      };
      replacementProc.stdout = new EventEmitter();
      replacementProc.stderr = new EventEmitter();
      tasks.runningBashProcs.set(taskId, replacementProc);

      await makeRequest(port, "POST", `/api/v1/tasks/${taskId}/cancel`);
      assert.deepEqual(replacementSignals, ["SIGINT"]);
    });

    it("returns idempotent idle status when task is idle", async () => {
      const taskId = await createTask();
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${taskId}/cancel`,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), {
        ok: true,
        status: "idle",
      });
    });

    it("returns 404 for unknown task", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks/nonexistent/cancel",
      );
      assert.equal(res.status, 404);
    });

    it("returns 503 when bridge is not ready", async () => {
      const taskId = await createTask();
      tasks.activePrompts.add(taskId);

      const handler = createRequestHandler({
        store,
        tasks,
        getBridge: () => null,
        publicDir,
        dataDir: tmpDir,
        limits: { bash_output: 1024, image_upload: 1024 },
        sseManager: { broadcast() {} } as any,
      });
      const srv = http.createServer(handler);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const p = (srv.address() as { port: number }).port;

      const res = await makeRequest(
        p,
        "POST",
        `/api/v1/tasks/${taskId}/cancel`,
      );
      assert.equal(res.status, 503);
      await new Promise<void>((r) =>
        srv.close(() => {
          r();
        }),
      );
    });

    it("is idempotent when the same X-Client-Op-Id is replayed", async () => {
      const taskId = await createTask();
      tasks.activePrompts.add(taskId);
      tasks.syncBusy(taskId);

      let callCount = 0;
      mockBridge.cancel = async () => {
        callCount++;
      };

      const headers = { "X-Client-Op-Id": "op-cancel-1" };
      const res1 = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${taskId}/cancel`,
        undefined,
        headers,
      );
      assert.equal(res1.status, 202);
      assert.equal(callCount, 1);

      const res2 = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${taskId}/cancel`,
        undefined,
        headers,
      );
      assert.equal(res2.status, 202);
      assert.equal(res2.body, res1.body);
      assert.equal(callCount, 1);

      const res3 = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${taskId}/cancel`,
        undefined,
        { "X-Client-Op-Id": "op-cancel-2" },
      );
      assert.equal(res3.status, 202);
      assert.equal(callCount, 2);
    });
  });

  describe("GET /api/v1/tasks/:id/status", () => {
    it("returns idle status when no active work", async () => {
      const taskId = await createTask();
      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/status`,
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.busy, false);
      assert.equal(body.busyKind, null);
      assert.deepEqual(body.pendingPermissions, []);
    });

    it("returns busy with agent when prompt is active", async () => {
      const taskId = await createTask();
      tasks.activePrompts.add(taskId);

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/status`,
      );
      const body = JSON.parse(res.body);
      assert.equal(body.busy, true);
      assert.equal(body.busyKind, "agent");
    });

    it("returns busy with bash when bash is running", async () => {
      const taskId = await createTask();
      const fakeProc = new EventEmitter() as any;
      fakeProc.pid = 12345;
      fakeProc.kill = () => true;
      fakeProc.stdout = new EventEmitter();
      fakeProc.stderr = new EventEmitter();
      tasks.runningBashProcs.set(taskId, fakeProc);

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/tasks/${taskId}/status`,
      );
      const body = JSON.parse(res.body);
      assert.equal(body.busy, true);
      assert.equal(body.busyKind, "bash");
    });

    it("returns 404 for unknown task", async () => {
      const res = await makeRequest(
        port,
        "GET",
        "/api/v1/tasks/nonexistent/status",
      );
      assert.equal(res.status, 404);
    });
  });

  describe("GET /api/v1/config", () => {
    it("returns configOptions and cancelTimeout", async () => {
      // Create a task to populate cachedConfigOptions
      await createTask();

      const res = await makeRequest(port, "GET", "/api/v1/config");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.configOptions));
      assert.equal(body.cancelTimeout, 10000);
    });

    it("returns empty configOptions when no tasks exist", async () => {
      const res = await makeRequest(port, "GET", "/api/v1/config");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.configOptions, []);
    });
  });
});
