import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

// Mock fetch globally before importing the module
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchResponse: { status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> };

function mockFetch(url: string | URL | Request, init?: RequestInit) {
  fetchCalls.push({ url: String(url), init });
  return Promise.resolve(fetchResponse);
}

describe("api module", () => {
  let api: typeof import("../public/js/api.ts");

  beforeEach(async () => {
    setupDOM();
    fetchCalls = [];
    fetchResponse = { status: 200, ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("{}") };
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

  it("createSession sends POST /api/sessions with correct body", async () => {
    const data = { id: "s1", cwd: "/tmp" };
    fetchResponse = { status: 201, ok: true, json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)) };
    const result = await api.createSession({ cwd: "/tmp", inheritFromSessionId: "s0" });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/sessions");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.cwd, "/tmp");
    assert.equal(body.inheritFromSessionId, "s0");
    assert.equal(result.id, "s1");
  });

  it("createSession omits undefined fields", async () => {
    fetchResponse = { status: 201, ok: true, json: () => Promise.resolve({ id: "s1" }), text: () => Promise.resolve('{"id":"s1"}') };
    await api.createSession();
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.cwd, undefined);
    assert.equal(body.inheritFromSessionId, undefined);
  });

  it("deleteSession sends DELETE /api/sessions/:id", async () => {
    await api.deleteSession("s1");
    assert.equal(fetchCalls[0].url, "/api/sessions/s1");
    assert.equal(fetchCalls[0].init?.method, "DELETE");
  });

  it("listSessions sends GET /api/sessions", async () => {
    fetchResponse = { status: 200, ok: true, json: () => Promise.resolve([]), text: () => Promise.resolve("[]") };
    await api.listSessions();
    assert.equal(fetchCalls[0].url, "/api/sessions");
    assert.equal(fetchCalls[0].init, undefined); // GET, no init
  });

  it("getSession sends GET /api/sessions/:id", async () => {
    fetchResponse = { status: 200, ok: true, json: () => Promise.resolve({ id: "s1" }), text: () => Promise.resolve('{"id":"s1"}') };
    await api.getSession("s1");
    assert.equal(fetchCalls[0].url, "/api/sessions/s1");
  });

  // --- Prompt ---

  it("sendMessage sends POST /api/sessions/:id/messages", async () => {
    fetchResponse = { status: 202, ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") };
    await api.sendMessage("s1", "hello", [{ url: "data:image/png;base64,abc" }]);
    assert.equal(fetchCalls[0].url, "/api/sessions/s1/messages");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.text, "hello");
    assert.deepEqual(body.images, [{ url: "data:image/png;base64,abc" }]);
  });

  it("sendMessage omits images when empty", async () => {
    fetchResponse = { status: 202, ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") };
    await api.sendMessage("s1", "hello");
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.images, undefined);
  });

  // --- Cancel ---

  it("cancelSession sends POST /api/sessions/:id/cancel", async () => {
    await api.cancelSession("s1");
    assert.equal(fetchCalls[0].url, "/api/sessions/s1/cancel");
    assert.equal(fetchCalls[0].init?.method, "POST");
  });

  // --- Permissions ---

  it("resolvePermission sends POST /api/permissions/:requestId", async () => {
    await api.resolvePermission("req1", "allow_once");
    assert.equal(fetchCalls[0].url, "/api/permissions/req1");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.optionId, "allow_once");
  });

  // --- Config ---

  it("setConfig sends PATCH /api/sessions/:id", async () => {
    await api.setConfig("s1", "model", "gpt-4");
    assert.equal(fetchCalls[0].url, "/api/sessions/s1");
    assert.equal(fetchCalls[0].init?.method, "PATCH");
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.configId, "model");
    assert.equal(body.value, "gpt-4");
  });

  // --- Bash ---

  it("execBash sends POST /api/sessions/:id/bash", async () => {
    await api.execBash("s1", "ls -la");
    assert.equal(fetchCalls[0].url, "/api/sessions/s1/bash");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.command, "ls -la");
  });

  it("cancelBash sends POST /api/sessions/:id/bash/cancel", async () => {
    await api.cancelBash("s1");
    assert.equal(fetchCalls[0].url, "/api/sessions/s1/bash/cancel");
    assert.equal(fetchCalls[0].init?.method, "POST");
  });

  // --- Visibility ---

  it("postVisibility sends POST /api/clients/:clientId/visibility", async () => {
    await api.postVisibility("cl-abc", true);
    assert.equal(fetchCalls[0].url, "/api/clients/cl-abc/visibility");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    assert.equal(body.visible, true);
  });

  // --- Status ---

  it("getStatus sends GET /api/sessions/:id/status", async () => {
    fetchResponse = { status: 200, ok: true, json: () => Promise.resolve({ busy: false }), text: () => Promise.resolve("") };
    await api.getStatus("s1");
    assert.equal(fetchCalls[0].url, "/api/sessions/s1/status");
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
