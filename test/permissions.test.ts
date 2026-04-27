import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type {
  ConfigOption,
  AgentEvent,
  PendingPermission,
} from "../src/types.ts";
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

function createMockBridge() {
  const configOptions: ConfigOption[] = [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "claude-sonnet",
      options: [{ value: "claude-sonnet", name: "Sonnet" }],
    },
  ];
  let idCounter = 0;
  let lastResolve: { requestId: string; optionId: string } | null = null;
  let lastDeny: string | null = null;
  return {
    ...mockBridgeStubs(),
    newSession: async () => {
      idCounter++;
      return `mock-session-${idCounter}`;
    },
    loadSession: async () => ({ sessionId: "", configOptions }),
    setConfigOption: async (_s: string, configId: string, value: string) =>
      configOptions.map((opt) =>
        opt.id === configId ? { ...opt, currentValue: value } : opt,
      ),
    cancel: async () => {},
    prompt: async () => {},
    resolvePermission: async (requestId: string, optionId: string) => {
      lastResolve = { requestId, optionId };
    },
    denyPermission: async (requestId: string) => {
      lastDeny = requestId;
    },
    get lastResolve() {
      return lastResolve;
    },
    get lastDeny() {
      return lastDeny;
    },
    resetTracking() {
      lastResolve = null;
      lastDeny = null;
    },
  };
}

describe("Permissions REST API", () => {
  let store: Store;
  let sessions: SessionManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;
  let broadcastEvents: AgentEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-perm-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(join(tmpDir, "test.db"));
    sessions = new SessionManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();
    broadcastEvents = [];

    const handler = createRequestHandler({
      store,
      sessions,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager: {
        broadcast: (event: AgentEvent) => broadcastEvents.push(event),
      } as any,
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

  async function createSession(): Promise<string> {
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions",
      JSON.stringify({ cwd: tmpDir }),
    );
    return JSON.parse(res.body).id;
  }

  function addPendingPermission(
    sessionId: string,
    requestId: string,
  ): PendingPermission {
    const perm: PendingPermission = {
      requestId,
      sessionId,
      title: "Run bash: npm test",
      options: [
        { optionId: "allow_once", label: "Allow once" },
        { optionId: "allow_always", label: "Allow always" },
        { optionId: "deny", label: "Deny" },
      ],
    };
    sessions.pendingPermissions.set(requestId, perm);
    return perm;
  }

  describe("GET /api/v1/sessions/:id/permissions", () => {
    it("returns empty array when no pending permissions", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/permissions`,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), []);
    });

    it("returns all pending permissions for a session", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");
      addPendingPermission(sessionId, "perm-2");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/permissions`,
      );
      assert.equal(res.status, 200);
      const perms = JSON.parse(res.body);
      assert.equal(perms.length, 2);
      assert.equal(perms[0].requestId, "perm-1");
      assert.equal(perms[1].requestId, "perm-2");
    });

    it("returns only permissions for the requested session", async () => {
      const s1 = await createSession();
      const s2 = await createSession();
      addPendingPermission(s1, "perm-1");
      addPendingPermission(s2, "perm-2");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${s1}/permissions`,
      );
      const perms = JSON.parse(res.body);
      assert.equal(perms.length, 1);
      assert.equal(perms[0].requestId, "perm-1");
    });
  });

  describe("POST /api/v1/sessions/:id/permissions/:reqId", () => {
    it("approves a permission with optionId", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({ optionId: "allow_once" }),
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
      assert.deepEqual(mockBridge.lastResolve, {
        requestId: "perm-1",
        optionId: "allow_once",
      });
      // Permission should be removed from pending
      assert.ok(!sessions.pendingPermissions.has("perm-1"));
    });

    it("denies a permission", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({ denied: true }),
      );
      assert.equal(res.status, 200);
      assert.equal(mockBridge.lastDeny, "perm-1");
      assert.ok(!sessions.pendingPermissions.has("perm-1"));
    });

    it("stores permission_response event", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");

      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({ optionId: "allow_once" }),
      );
      const events = store.getEvents(sessionId);
      const permEvent = events.find((e) => e.type === "permission_response");
      assert.ok(permEvent);
      const data = JSON.parse(permEvent.data);
      assert.equal(data.requestId, "perm-1");
      assert.equal(data.optionId, "allow_once");
    });

    it("broadcasts permission_response event", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");
      broadcastEvents = [];

      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({ optionId: "allow_once" }),
      );
      const resolved = broadcastEvents.find(
        (e: any) => e.type === "permission_response",
      );
      assert.ok(resolved);
    });

    it("returns 404 for unknown requestId", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/nonexistent`,
        JSON.stringify({ optionId: "allow_once" }),
      );
      assert.equal(res.status, 404);
    });

    it("returns 400 for missing optionId and denied", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({}),
      );
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        "not json",
      );
      assert.equal(res.status, 400);
    });

    it("is idempotent — returns 200 for already-resolved permission", async () => {
      // After a permission is resolved, it's removed from pending.
      // A second POST should return 404 since it's gone.
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({ optionId: "allow_once" }),
      );

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({ optionId: "allow_once" }),
      );
      assert.equal(res.status, 404);
    });

    it("returns 503 when bridge is not ready", async () => {
      const sessionId = await createSession();
      addPendingPermission(sessionId, "perm-1");

      const handler = createRequestHandler({
        store,
        sessions,
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
        `/api/v1/sessions/${sessionId}/permissions/perm-1`,
        JSON.stringify({ optionId: "allow_once" }),
      );
      assert.equal(res.status, 503);
      await new Promise<void>((r) =>
        srv.close(() => {
          r();
        }),
      );
    });
  });
});
