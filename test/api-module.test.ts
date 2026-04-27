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

  // --- Session CRUD ---

  it("createSession sends POST /api/v1/sessions with correct body", async () => {
    const data = { id: "s1", cwd: "/tmp" };
    fetchResponse = {
      status: 201,
      ok: true,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };
    const result = await api.createSession({
      cwd: "/tmp",
      inheritFromSessionId: "s0",
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/v1/sessions");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.cwd, "/tmp");
    assert.equal(body.inheritFromSessionId, "s0");
    assert.equal(result.id, "s1");
  });

  it("createSession omits undefined fields", async () => {
    fetchResponse = {
      status: 201,
      ok: true,
      json: () => Promise.resolve({ id: "s1" }),
      text: () => Promise.resolve('{"id":"s1"}'),
    };
    await api.createSession();
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.cwd, undefined);
    assert.equal(body.inheritFromSessionId, undefined);
  });

  it("deleteSession sends DELETE /api/v1/sessions/:id", async () => {
    await api.deleteSession("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1");
    assert.equal(fetchCalls[0].init!.method, "DELETE");
  });

  it("listSessions sends GET /api/v1/sessions", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
    };
    await api.listSessions();
    assert.equal(fetchCalls[0].url, "/api/v1/sessions");
    assert.equal(fetchCalls[0].init, undefined); // GET, no init
  });

  it("getSession sends GET /api/v1/sessions/:id", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({ id: "s1" }),
      text: () => Promise.resolve('{"id":"s1"}'),
    };
    await api.getSession("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1");
  });

  // --- Prompt ---

  it("sendMessage sends POST /api/v1/sessions/:id/prompt", async () => {
    fetchResponse = {
      status: 202,
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    };
    await api.sendMessage("s1", "hello", [
      { url: "data:image/png;base64,abc" },
    ]);
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/prompt");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.text, "hello");
    assert.deepEqual(body.images, [{ url: "data:image/png;base64,abc" }]);
  });

  it("sendMessage omits images when empty", async () => {
    fetchResponse = {
      status: 202,
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    };
    await api.sendMessage("s1", "hello");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.images, undefined);
  });

  // --- Cancel ---

  it("cancelSession sends POST /api/v1/sessions/:id/cancel", async () => {
    await api.cancelSession("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/cancel");
    assert.equal(fetchCalls[0].init!.method, "POST");
  });

  // --- Permissions ---

  it("resolvePermission sends POST /api/v1/sessions/:id/permissions/:requestId", async () => {
    await api.resolvePermission("s1", "req1", "allow_once");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/permissions/req1");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.optionId, "allow_once");
  });

  it("denyPermission sends POST /api/v1/sessions/:id/permissions/:requestId with denied flag", async () => {
    await api.denyPermission("s1", "req2");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/permissions/req2");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.denied, true);
  });

  // --- Config ---

  it("setConfig sends PUT /api/v1/sessions/:id/:configId", async () => {
    await api.setConfig("s1", "model", "gpt-4");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/model");
    assert.equal(fetchCalls[0].init!.method, "PUT");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.value, "gpt-4");
  });

  // --- Bash ---

  it("execBash sends POST /api/v1/sessions/:id/bash", async () => {
    await api.execBash("s1", "ls -la");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/bash");
    assert.equal(fetchCalls[0].init!.method, "POST");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.command, "ls -la");
  });

  it("cancelBash sends POST /api/v1/sessions/:id/bash/cancel", async () => {
    await api.cancelBash("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/bash/cancel");
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

  it("postVisibility includes sessionId when provided", async () => {
    await api.postVisibility("cl-abc", true, "session-123");
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.visible, true);
    assert.equal(body.sessionId, "session-123");
  });

  it("postVisibility omits sessionId when undefined", async () => {
    await api.postVisibility("cl-abc", false);
    const body = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(body.visible, false);
    assert.equal(body.sessionId, undefined);
  });

  // --- Status ---

  it("getStatus sends GET /api/v1/sessions/:id/status", async () => {
    fetchResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({ busy: false }),
      text: () => Promise.resolve(""),
    };
    await api.getStatus("s1");
    assert.equal(fetchCalls[0].url, "/api/v1/sessions/s1/status");
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
      () => api.deleteSession("s1"),
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
      () => api.deleteSession("s1"),
      (err: any) => {
        assert.equal(err.name, "ApiError");
        assert.equal(err.status, 500);
        return true;
      },
    );
  });
});
