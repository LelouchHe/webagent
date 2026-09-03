import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
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

/** Minimal mock bridge that returns a predictable session ID. */
function createMockBridge(nextId = "mock-session-1") {
  let idCounter = 0;
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
    ...mockBridgeStubs(),
    newSession: async (_cwd: string) => {
      idCounter++;
      return {
        sessionId: idCounter === 1 ? nextId : `mock-session-${idCounter}`,
        configOptions: [],
      };
    },
    loadSession: async (_sessionId: string, _cwd: string) => ({
      sessionId: _sessionId,
      configOptions,
    }),
    setConfigOption: async (
      _sessionId: string,
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

describe("Session REST API", () => {
  let store: Store;
  let sessions: SessionManager;
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
    sessions = new SessionManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();
    broadcastEvents = [];

    const handler = createRequestHandler({
      store,
      sessions,
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

  // --- POST /api/v1/sessions ---

  describe("POST /api/v1/sessions", () => {
    it("creates a session with default cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.match(body.id, /^[0-9a-f-]{36}$/);
      assert.equal(store.getAgentSessionId(body.id), "mock-session-1");
      assert.equal(body.cwd, tmpDir);
      assert.equal(body.title, null);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("coalesces concurrent bootstrap requests into one session", async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          makeRequest(port, "POST", "/api/v1/sessions/bootstrap"),
        ),
      );

      assert.ok(responses.every((response) => response.status === 200));
      const bodies = responses.map((response) => JSON.parse(response.body));
      assert.equal(new Set(bodies.map((body) => body.id)).size, 1);
      assert.equal(store.listSessions().length, 1);
      assert.equal(
        broadcastEvents.filter((event) => event.type === "session_created")
          .length,
        1,
      );
      assert.equal(
        broadcastEvents.find((event) => event.type === "session_created")
          ?.clientOpId,
        undefined,
      );
    });

    it("bootstrap reuses the current-agent session while explicit create does not", async () => {
      const first = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions/bootstrap",
      );
      const bootstrapId = JSON.parse(first.body).id;

      const second = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions/bootstrap",
      );
      assert.equal(JSON.parse(second.body).id, bootstrapId);

      const explicit = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      assert.notEqual(JSON.parse(explicit.body).id, bootstrapId);
      assert.equal(store.listSessions().length, 2);
    });

    it("bootstrap ignores sessions owned by another agent", async () => {
      const other = new Store(tmpDir, "other-agent");
      other.createSession("other-web", tmpDir, "auto", "other-agent-session");
      other.close();

      const response = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions/bootstrap",
      );
      const body = JSON.parse(response.body);

      assert.equal(response.status, 200);
      assert.notEqual(body.id, "other-web");
      assert.equal(store.listSessions().length, 1);
      assert.equal(store.getSession("other-web"), undefined);
    });

    describe("POST /api/v1/sessions/:id/cancel", () => {
      it("resends cancel while the agent prompt remains active", async () => {
        store.createSession("s-cancel", tmpDir);
        sessions.activePrompts.add("s-cancel");
        sessions.syncBusy("s-cancel", "p1");
        let cancelCalls = 0;
        mockBridge.cancel = async () => {
          cancelCalls++;
        };

        const first = await makeRequest(
          port,
          "POST",
          "/api/v1/sessions/s-cancel/cancel",
          "{}",
        );
        const second = await makeRequest(
          port,
          "POST",
          "/api/v1/sessions/s-cancel/cancel",
          "{}",
        );

        assert.equal(first.status, 202);
        assert.equal(second.status, 202);
        assert.equal(cancelCalls, 2);
        assert.equal(sessions.activePrompts.has("s-cancel"), true);
        assert.equal(
          sessions.state.getState("s-cancel").runtime.busy?.cancelStatus,
          "requested",
        );

        sessions.runningBashProcs.set("s-cancel", {} as any);
        sessions.syncBusy("s-cancel");
        assert.equal(
          sessions.state.getState("s-cancel").runtime.busy?.kind,
          "agent",
        );
        assert.equal(
          sessions.state.getState("s-cancel").runtime.busy?.cancelStatus,
          "requested",
        );
      });

      it("returns idempotent idle status when no work is active", async () => {
        store.createSession("s-idle", tmpDir);

        const res = await makeRequest(
          port,
          "POST",
          "/api/v1/sessions/s-idle/cancel",
          "{}",
        );

        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.body), {
          ok: true,
          status: "idle",
        });
      });

      it("does not attach a stale cancel to a replacement prompt", async () => {
        store.createSession("s-race", tmpDir);
        sessions.activePrompts.add("s-race");
        sessions.syncBusy("s-race");
        const oldPromptId =
          sessions.state.getState("s-race").runtime.busy?.promptId;
        let releaseCancel: (() => void) | undefined;
        mockBridge.cancel = () =>
          new Promise<void>((resolve) => {
            releaseCancel = resolve;
          });

        const cancelRequest = makeRequest(
          port,
          "POST",
          "/api/v1/sessions/s-race/cancel",
          "{}",
        );
        for (let i = 0; i < 10 && !releaseCancel; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(releaseCancel);
        sessions.activePrompts.delete("s-race");
        sessions.syncBusy("s-race");
        sessions.activePrompts.add("s-race");
        sessions.syncBusy("s-race");
        const newPromptId =
          sessions.state.getState("s-race").runtime.busy?.promptId;
        assert.notEqual(newPromptId, oldPromptId);

        releaseCancel();
        const res = await cancelRequest;

        assert.equal(res.status, 202);
        assert.equal(JSON.parse(res.body).status, "superseded");
        assert.equal(
          sessions.state.getState("s-race").runtime.busy?.cancelStatus ?? null,
          null,
        );
        assert.equal(
          sessions.state.getState("s-race").runtime.busy?.promptId,
          newPromptId,
        );
      });

      it("reports superseded when a replacement prompt is still reserved", async () => {
        store.createSession("s-reserved-race", tmpDir);
        sessions.activePrompts.add("s-reserved-race");
        sessions.syncBusy("s-reserved-race");
        let releaseCancel: (() => void) | undefined;
        mockBridge.cancel = () =>
          new Promise<void>((resolve) => {
            releaseCancel = resolve;
          });

        const cancelRequest = makeRequest(
          port,
          "POST",
          "/api/v1/sessions/s-reserved-race/cancel",
          "{}",
        );
        for (let i = 0; i < 10 && !releaseCancel; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(releaseCancel);
        sessions.activePrompts.delete("s-reserved-race");
        sessions.syncBusy("s-reserved-race");
        const replacementSubmission =
          sessions.reservePromptSubmission("s-reserved-race");
        assert.ok(replacementSubmission);

        releaseCancel();
        const res = await cancelRequest;

        assert.equal(res.status, 202);
        assert.equal(JSON.parse(res.body).status, "superseded");
        assert.equal(
          sessions.pendingPromptSubmissions.has("s-reserved-race"),
          true,
        );
        sessions.releasePromptSubmission(
          "s-reserved-race",
          replacementSubmission,
        );
      });

      it("cancels a prompt submission while session resume is pending", async () => {
        store.createSession("s-pending", tmpDir);
        let releaseResume!: () => void;
        let promptCalls = 0;
        mockBridge.loadSession = () =>
          new Promise((resolve) => {
            releaseResume = () => {
              resolve({ sessionId: "s-pending", configOptions: [] });
            };
          });
        mockBridge.prompt = async () => {
          promptCalls++;
        };

        const promptRequest = makeRequest(
          port,
          "POST",
          "/api/v1/sessions/s-pending/prompt",
          JSON.stringify({ text: "do not run" }),
        );
        for (
          let i = 0;
          i < 10 && !sessions.pendingPromptSubmissions.has("s-pending");
          i++
        ) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(sessions.pendingPromptSubmissions.has("s-pending"), true);

        const cancelRes = await makeRequest(
          port,
          "POST",
          "/api/v1/sessions/s-pending/cancel",
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

    it("creates a session with custom cwd", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        JSON.stringify({ cwd: tmpDir }),
      );
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.cwd, tmpDir);
    });

    it("creates a session inheriting from another", async () => {
      // Create first session to inherit from
      const res1 = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const s1 = JSON.parse(res1.body);

      const res2 = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        JSON.stringify({ inheritFromSessionId: s1.id }),
      );
      assert.equal(res2.status, 201);
      const s2 = JSON.parse(res2.body);
      assert.notEqual(s2.id, s1.id);
    });

    it("creates a session with source field", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        JSON.stringify({ source: "user" }),
      );
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "user");
    });

    it("defaults source to auto", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "auto");
    });

    it("broadcasts session_created event", async () => {
      await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const created = broadcastEvents.find((e) => e.type === "session_created");
      assert.ok(created, "should broadcast session_created");
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "not-json",
      );
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid cwd", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        JSON.stringify({ cwd: "/nonexistent/path/12345" }),
      );
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      // Create handler with no bridge
      const handler = createRequestHandler({
        store,
        sessions,
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

      const res = await makeRequest(p2, "POST", "/api/v1/sessions", "{}");
      assert.equal(res.status, 503);

      await new Promise<void>((resolve) =>
        s2.close(() => {
          resolve();
        }),
      );
    });
  });

  // --- POST /api/v1/sessions/:id/clear ---

  describe("POST /api/v1/sessions/:id/clear", () => {
    it("keeps the WebAgent session id while rotating its ACP execution", async () => {
      store.createSession("s1", tmpDir, "auto", "agent-old");

      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions/s1/clear",
        "{}",
      );

      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "s1");
      assert.equal(store.listSessions().length, 1);
      assert.equal(store.getAgentSessionId("s1"), "mock-session-1");
      assert.equal(store.getWebSessionId("agent-old"), undefined);
    });
  });

  // --- GET /api/v1/sessions/:id ---

  describe("GET /api/v1/sessions/:id", () => {
    it("returns session detail for existing session", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "GET", `/api/v1/sessions/${id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, id);
      assert.equal(body.cwd, tmpDir);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(
        port,
        "GET",
        "/api/v1/sessions/nonexistent",
      );
      assert.equal(res.status, 404);
    });

    it("auto-resumes a non-live session", async () => {
      // Create a session directly in store (not in liveSessions)
      store.createSession("stored-only", tmpDir);

      const res = await makeRequest(
        port,
        "GET",
        "/api/v1/sessions/stored-only",
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "stored-only");
      // Should now be live
      assert.ok(sessions.liveSessions.has("stored-only"));
    });

    it("does not continue an interrupted turn while restoring", async () => {
      store.createSession("interrupted", tmpDir);
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

      const res = await makeRequest(
        port,
        "GET",
        "/api/v1/sessions/interrupted",
      );
      assert.equal(res.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.ok(sessions.liveSessions.has("interrupted"));
      assert.equal(promptCalls, 0);
      assert.equal(sessions.getBusyKind("interrupted"), null);
    });

    it("snapshot waits for command discovery during a warm-cache resume", async () => {
      store.createSession("stored-only", tmpDir);
      sessions.cachedConfigOptions.push({
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "claude-sonnet",
        options: [{ value: "claude-sonnet", name: "Sonnet" }],
      });
      mockBridge.loadSession = async (sessionId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        sessions.updateAgentCommands(sessionId, [
          { name: "context", description: "Show context usage" },
        ]);
        return { sessionId, configOptions: [] };
      };

      const detail = await makeRequest(
        port,
        "GET",
        "/api/v1/sessions/stored-only",
      );
      assert.equal(detail.status, 200);
      const snapshot = await makeRequest(
        port,
        "GET",
        "/api/v1/sessions/stored-only/snapshot",
      );

      assert.deepEqual(JSON.parse(snapshot.body).agentCommands.commands, [
        { name: "context", description: "Show context usage" },
      ]);
    });
  });

  // --- DELETE /api/v1/sessions/:id ---

  describe("DELETE /api/v1/sessions/:id", () => {
    it("deletes an existing session", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "DELETE", `/api/v1/sessions/${id}`);
      assert.equal(res.status, 204);
      assert.equal(res.body, "");

      // Verify deleted from store
      assert.equal(store.getSession(id), undefined);
    });

    it("broadcasts session_deleted event", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);
      broadcastEvents.length = 0;

      await makeRequest(port, "DELETE", `/api/v1/sessions/${id}`);
      const deleted = broadcastEvents.find((e) => e.type === "session_deleted");
      assert.ok(deleted, "should broadcast session_deleted");
      /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrowing after assert.ok */
      if (deleted) {
        assert.equal(deleted.sessionId, id);
      }
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(
        port,
        "DELETE",
        "/api/v1/sessions/nonexistent",
      );
      assert.equal(res.status, 404);
    });

    it("protects the Root session from deletion", async () => {
      store.ensureRootSession(tmpDir);
      store.bindAgentSession("root", "agent-root");

      const res = await makeRequest(port, "DELETE", "/api/v1/sessions/root");

      assert.equal(res.status, 400);
      assert.match(res.body, /Root session cannot be deleted/);
      assert.equal(store.getSession("root")?.id, "root");
    });

    it("rejects deletion while prompt work is active", async () => {
      store.createSession("s-active-delete", tmpDir);
      sessions.activePrompts.add("s-active-delete");
      sessions.syncBusy("s-active-delete");

      const res = await makeRequest(
        port,
        "DELETE",
        "/api/v1/sessions/s-active-delete",
      );

      assert.equal(res.status, 409);
      assert.equal(store.getSession("s-active-delete")?.id, "s-active-delete");
    });

    it("rejects deletion while prompt submission is pending", async () => {
      store.createSession("s-pending-delete", tmpDir);
      assert.notEqual(
        sessions.reservePromptSubmission("s-pending-delete"),
        null,
      );

      const res = await makeRequest(
        port,
        "DELETE",
        "/api/v1/sessions/s-pending-delete",
      );

      assert.equal(res.status, 409);
      assert.equal(
        store.getSession("s-pending-delete")?.id,
        "s-pending-delete",
      );
    });
  });

  // --- PUT /api/v1/sessions/:id/:configId ---

  describe("PUT /api/v1/sessions/:id/:configId", () => {
    it("updates model config", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/sessions/${id}/model`,
        JSON.stringify({ value: "claude-haiku" }),
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("updates mode config", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/sessions/${id}/mode`,
        JSON.stringify({ value: "agent#autopilot" }),
      );
      assert.equal(res.status, 200);
    });

    it("updates arbitrary boolean config via /config/:configId", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/sessions/${id}/config/allow-all`,
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
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);
      broadcastEvents.length = 0;

      await makeRequest(
        port,
        "PUT",
        `/api/v1/sessions/${id}/model`,
        JSON.stringify({ value: "claude-haiku" }),
      );
      const update = broadcastEvents.find(
        (e) => e.type === "config_option_update",
      );
      assert.ok(update, "should broadcast config_option_update");
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(
        port,
        "PUT",
        "/api/v1/sessions/nonexistent/model",
        JSON.stringify({ value: "x" }),
      );
      assert.equal(res.status, 404);
    });

    it("returns 400 for empty body", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/sessions/${id}/model`,
        "{}",
      );
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(
        port,
        "PUT",
        `/api/v1/sessions/${id}/model`,
        "not-json",
      );
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      store.createSession("no-bridge", tmpDir);
      const handler = createRequestHandler({
        store,
        sessions,
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
        "/api/v1/sessions/no-bridge/model",
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

  // --- GET /api/v1/sessions with source filter ---

  describe("GET /api/v1/sessions?source=", () => {
    it("filters sessions by source", async () => {
      await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        JSON.stringify({ source: "user" }),
      );
      await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        JSON.stringify({ source: "auto" }),
      );

      const allRes = await makeRequest(port, "GET", "/api/v1/sessions");
      assert.equal(JSON.parse(allRes.body).length, 2);

      const userRes = await makeRequest(
        port,
        "GET",
        "/api/v1/sessions?source=user",
      );
      const userSessions = JSON.parse(userRes.body);
      assert.equal(userSessions.length, 1);
      assert.equal(userSessions[0].source, "user");

      const autoRes = await makeRequest(
        port,
        "GET",
        "/api/v1/sessions?source=auto",
      );
      const autoSessions = JSON.parse(autoRes.body);
      assert.equal(autoSessions.length, 1);
      assert.equal(autoSessions[0].source, "auto");
    });

    it("returns all sessions without source filter", async () => {
      await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        JSON.stringify({ source: "user" }),
      );
      await makeRequest(port, "POST", "/api/v1/sessions", "{}");

      const res = await makeRequest(port, "GET", "/api/v1/sessions");
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
      // Create session and add enough events to exceed 1KB threshold
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      const longText = "A".repeat(2000);
      store.saveEvent(
        sessionId,
        "assistant_message",
        { text: longText },
        { from_ref: "agent" },
      );

      const res = await makeRawRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
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
        `/api/v1/sessions/${sessionId}/events`,
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
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      store.saveEvent(
        sessionId,
        "assistant_message",
        { text: "B".repeat(2000) },
        { from_ref: "agent" },
      );

      const res = await makeRawRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
      );

      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], undefined);
      const body = JSON.parse(res.rawBody.toString());
      assert.ok(Array.isArray(body.events));
    });

    it("skips gzip for small responses under 1KB", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      store.saveEvent(
        sessionId,
        "assistant_message",
        { text: "tiny" },
        { from_ref: "agent" },
      );

      const res = await makeRawRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
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
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      // Simulate agent mid-thinking: buffer has unflushed content
      sessions.appendThinking(sessionId, "partial thought");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
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
      assert.equal(sessions.thinkingBuffers.has(sessionId), false);
    });

    it("flushes pending assistant buffer and signals streaming", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      sessions.appendAssistant(sessionId, "partial reply");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
      );
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, false);
      assert.equal(body.streaming.assistant, true);
      const msgEvt = body.events.find(
        (e: { type: string }) => e.type === "assistant_message",
      );
      assert.ok(msgEvt, "should include flushed assistant_message event");
      assert.equal(sessions.assistantBuffers.has(sessionId), false);
    });

    it("returns streaming false when no buffers are pending", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      store.saveEvent(
        sessionId,
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
      );
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, false);
      assert.equal(body.streaming.assistant, false);
    });

    it("does not signal streaming for empty buffers", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      sessions.assistantBuffers.set(sessionId, "");
      sessions.thinkingBuffers.set(sessionId, "");

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
      );
      const body = JSON.parse(res.body);

      assert.deepEqual(body.streaming, {
        thinking: false,
        assistant: false,
      });
      assert.equal(sessions.assistantBuffers.has(sessionId), false);
      assert.equal(sessions.thinkingBuffers.has(sessionId), false);
    });

    it("keeps an active stream open when its pending buffer is empty", async () => {
      const createRes = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions",
        "{}",
      );
      const sessionId = JSON.parse(createRes.body).id;
      store.saveEvent(
        sessionId,
        "user_message",
        { text: "question" },
        { from_ref: "user" },
      );
      store.saveEvent(
        sessionId,
        "assistant_message",
        { text: "partial reply" },
        { from_ref: "agent" },
      );
      sessions.assistantBuffers.set(sessionId, "");
      sessions.state.patch(sessionId, {
        runtime: {
          streaming: { thinking: false, assistant: true },
        },
      });

      const res = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${sessionId}/events`,
      );
      const body = JSON.parse(res.body);

      assert.deepEqual(body.streaming, {
        thinking: false,
        assistant: true,
      });
      assert.equal(sessions.assistantBuffers.has(sessionId), false);
    });
  });
});
