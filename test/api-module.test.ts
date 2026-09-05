import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

// Mock fetch globally before importing the module
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchResponse: {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function mockFetch(url: string | URL | Request, init?: RequestInit) {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- url is always coerced to string correctly
  fetchCalls.push({ url: String(url), init });
  return Promise.resolve(fetchResponse);
}

describe("api module", () => {
  let api: typeof import("../public/js/api.ts");

  beforeEach(async () => {
    setupDOM();
    fetchCalls = [];
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("{}"),
    };
    (globalThis as any).fetch = mockFetch;
    // Fresh import each time to avoid stale module state
    const mod = await import("../public/js/api.ts");
    api = mod;
  });

  afterEach(() => {
    teardownDOM();
    delete (globalThis as any).fetch;
  });

  // --- Task CRUD ---

  it("createTask sends POST /api/v1/tasks with correct body", async () => {
    const data = { id: "s1", cwd: "/tmp" };
    fetchResponse = {
      status: 201,
      ok: true,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };
    const result = await api.createTask({
      cwd: "/tmp",
      inheritFromTaskId: "s0",
      parentId: "s-parent",
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/v1/tasks");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.cwd, "/tmp");
    assert.equal(body.inheritFromTaskId, "s0");
    assert.equal(body.parentId, "s-parent");
    assert.equal(result.id, "s1");
  });

  it("createTask includes structured collaboration fields", async () => {
    fetchResponse = {
      status: 201,
      ok: true,
      json: () => Promise.resolve({ id: "child" }),
      text: () => Promise.resolve('{"id":"child"}'),
    };
    await api.createTask({
      parentId: "parent",
      cwd: "/tmp/work",
      title: "code review",
      brief: "review the release diff",
    });
    assert.deepEqual(JSON.parse(fetchCalls[0].init!.body as string), {
      parentId: "parent",
      cwd: "/tmp/work",
      title: "code review",
      brief: "review the release diff",
    });
  });

  it("createTask omits undefined fields", async () => {
    fetchResponse = {
      status: 201,
      ok: true,
      json: () => Promise.resolve({ id: "s1" }),
      text: () => Promise.resolve('{"id":"s1"}'),
    };
    await api.createTask();
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.cwd, undefined);
    assert.equal(body.inheritFromTaskId, undefined);
  });

  it("bootstrapTask sends POST /api/v1/tasks/bootstrap", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({ id: "s1", created: false }),
      text: () => Promise.resolve('{"id":"s1","created":false}'),
    };

    const result = await api.bootstrapTask();

    assert.equal(fetchCalls[0].url, "/api/v1/tasks/bootstrap");
    assert.equal(fetchCalls[0].init!.method, "POST");
    assert.equal(fetchCalls[0].init!.body, undefined);
    assert.equal(result.id, "s1");
  });

  it("deleteTask sends DELETE /api/v1/tasks/:id", async () => {
    await api.deleteTask("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1");
    assert.equal(fetchCalls[0].init!.method, "DELETE");
    assert.match(
      String(
        (fetchCalls[0].init!.headers as Record<string, string>)[
          "X-Client-Op-Id"
        ],
      ),
      /.+/,
    );
  });

  it("sendCollaborationMessage posts a structured target and body", async () => {
    fetchResponse = {
      status: 202,
      ok: true,
      json: () =>
        Promise.resolve({
          messageId: "message-1",
          deliveryId: "delivery-1",
          status: "queued",
        }),
      text: () =>
        Promise.resolve(
          '{"messageId":"message-1","deliveryId":"delivery-1","status":"queued"}',
        ),
    };
    await api.sendCollaborationMessage(
      "source id",
      "target id",
      "please review",
      "op-1",
    );
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/source%20id/messages");
    assert.equal(fetchCalls[0].init!.method, "POST");
    assert.deepEqual(JSON.parse(fetchCalls[0].init!.body as string), {
      targetTaskId: "target id",
      body: "please review",
    });
  });

  it("listTasks sends GET /api/v1/tasks", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
    };
    await api.listTasks();
    assert.equal(fetchCalls[0].url, "/api/v1/tasks");
    assert.equal(fetchCalls[0].init?.method, undefined); // GET
  });

  it("puts every request under an abort deadline", async () => {
    // A request with no deadline can stay pending forever on a stalled
    // connection, and callers latch state on those promises.
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
    };
    await api.listTasks();
    const signal = fetchCalls[0].init?.signal;
    assert.ok(signal, "GET must carry an abort signal");
    assert.equal(signal.aborted, false);

    fetchCalls.length = 0;
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("{}"),
    };
    await api.cancelTask("s1");
    assert.ok(fetchCalls[0].init?.signal, "POST must carry an abort signal");
    assert.equal(fetchCalls[0].init.method, "POST");
  });

  it("getTask sends GET /api/v1/tasks/:id", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({ id: "s1" }),
      text: () => Promise.resolve('{"id":"s1"}'),
    };
    await api.getTask("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1");
  });

  it("consumeMessage forwards the task inheritance source", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({}),
      text: () =>
        Promise.resolve('{"taskId":"new-task","alreadyConsumed":false}'),
    };

    await api.consumeMessage("m1", "current-task");

    assert.equal(fetchCalls[0].url, "/api/v1/messages/m1/consume");
    assert.equal(fetchCalls[0].init!.method, "POST");
    assert.deepEqual(JSON.parse(fetchCalls[0].init!.body as string), {
      inheritFromTaskId: "current-task",
    });
  });

  // --- File viewer ---

  it("getFileInfo URL-encodes arbitrary paths", async () => {
    const data = {
      path: "/Users/me/a b #ç.md",
      pathDisplay: "~/a b #ç.md",
      name: "a b #ç.md",
      kind: "file",
      size: 12,
      mtime: 1,
      mime: "text/plain",
      maxBytes: 1024,
      contentUrl: "/signed",
    };
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };

    const result = await api.getFileInfo(data.path);

    assert.equal(
      fetchCalls[0].url,
      `/api/v1/files/info?path=${encodeURIComponent(data.path)}`,
    );
    assert.equal(result.path, data.path);
    assert.equal(result.pathDisplay, data.pathDisplay);
    assert.equal(result.kind, "file");
  });

  it("listFiles URL-encodes paths and returns typed entries", async () => {
    const data = {
      path: "/Users/me/project",
      pathDisplay: "~/project",
      parent: "/Users/me",
      parentDisplay: "~",
      truncated: false,
      entries: [
        { name: "src", kind: "dir", size: null, mtime: 1 },
        { name: "a.ts", kind: "file", size: 12, mtime: 2 },
      ],
    };
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };

    const result = await api.listFiles(data.path);

    assert.equal(
      fetchCalls[0].url,
      `/api/v1/files/list?path=${encodeURIComponent(data.path)}`,
    );
    assert.equal(result.pathDisplay, "~/project");
    assert.equal(result.parentDisplay, "~");
    assert.equal(result.entries[0].kind, "dir");
    assert.equal(result.entries[1].name, "a.ts");
  });

  // --- Prompt ---

  it("sendMessage sends POST /api/v1/tasks/:id/prompt", async () => {
    fetchResponse = {
      status: 202,
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    };
    await api.sendMessage("s1", "hello", [
      {
        kind: "image",
        attachmentId: "a1",
        displayName: "tiny.png",
        mimeType: "image/png",
      },
    ]);
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/prompt");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.text, "hello");
    assert.deepEqual(body.attachments, [
      {
        kind: "image",
        attachmentId: "a1",
        displayName: "tiny.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("sendMessage omits attachments when empty", async () => {
    fetchResponse = {
      status: 202,
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    };
    await api.sendMessage("s1", "hello");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.attachments, undefined);
  });

  // --- Cancel ---

  it("cancelTask sends POST /api/v1/tasks/:id/cancel", async () => {
    await api.cancelTask("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/cancel");
    assert.equal(fetchCalls[0].init!.method, "POST");
  });

  // --- Permissions ---

  it("resolvePermission sends POST /api/v1/tasks/:id/permissions/:requestId", async () => {
    await api.resolvePermission("s1", "req1", "allow_once");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/permissions/req1");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.optionId, "allow_once");
  });

  it("denyPermission sends POST /api/v1/tasks/:id/permissions/:requestId with denied flag", async () => {
    await api.denyPermission("s1", "req2");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/permissions/req2");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.denied, true);
  });

  // --- Config ---

  it("setConfig sends PUT /api/v1/tasks/:id/:configId", async () => {
    await api.setConfig("s1", "model", "gpt-4");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/model");
    assert.equal(fetchCalls[0].init!.method, "PUT");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.value, "gpt-4");
  });

  // --- Bash ---

  it("execBash sends POST /api/v1/tasks/:id/bash", async () => {
    await api.execBash("s1", "ls -la");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/bash");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.command, "ls -la");
  });

  it("cancelBash sends POST /api/v1/tasks/:id/bash/cancel", async () => {
    await api.cancelBash("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/bash/cancel");
    assert.equal(fetchCalls[0].init!.method, "POST");
  });

  // --- Visibility ---

  it("postVisibility sends POST /api/beta/clients/:clientId/visibility", async () => {
    await api.postVisibility("cl-abc", true);
    assert.equal(fetchCalls[0].url, "/api/beta/clients/cl-abc/visibility");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.visible, true);
  });

  it("postVisibility includes taskId when provided", async () => {
    await api.postVisibility("cl-abc", true, "task-123");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.visible, true);
    assert.equal(body.taskId, "task-123");
  });

  it("postVisibility omits taskId when undefined", async () => {
    await api.postVisibility("cl-abc", false);
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.visible, false);
    assert.equal(body.taskId, undefined);
  });

  // --- Status ---

  it("getStatus sends GET /api/v1/tasks/:id/status", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({ busy: false }),
      text: () => Promise.resolve(""),
    };
    await api.getStatus("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/tasks/s1/status");
  });

  // --- Error handling ---

  it("throws ApiError on non-ok response", async () => {
    fetchResponse = {
      status: 404,
      ok: false,
      json: () => Promise.resolve({ error: "not found" }),
      text: () => Promise.resolve('{"error":"not found"}'),
    };
    await assert.rejects(
      () => api.deleteTask("s1"),
      (err: any) => {
        assert.equal(err.name, "ApiError");
        assert.equal(err.status, 404);
        assert.equal(err.message, "not found");
        return true;
      },
    );
  });

  it("handles non-JSON error responses gracefully", async () => {
    fetchResponse = {
      status: 500,
      ok: false,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("Internal Server Error"),
    };
    await assert.rejects(
      () => api.deleteTask("s1"),
      (err: any) => {
        assert.equal(err.name, "ApiError");
        assert.equal(err.status, 500);
        return true;
      },
    );
  });
});
