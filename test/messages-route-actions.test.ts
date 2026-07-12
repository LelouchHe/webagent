import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import { SessionManager } from "../src/session-manager.ts";
import type { AgentEvent, ConfigOption } from "../src/types.ts";
import { mockBridgeStubs, waitFor } from "./fixtures.ts";

function send(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: d });
        });
      },
    );
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe("POST /api/v1/messages/:id/consume + ack + DELETE", () => {
  let store: Store;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let broadcasts: AgentEvent[];
  let sessions: SessionManager;
  let newSessionCalls: string[];
  let newSessionOptions: Array<{ silent?: boolean } | undefined>;
  let loadSessionCalls: string[];
  let failNewSession: boolean;
  let releaseNewSession: (() => void) | null;
  let configCalls: Array<{
    sessionId: string;
    configId: string;
    value: string;
  }>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-msg-action-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir);
    sessions = new SessionManager(store, tmpDir, tmpDir);
    newSessionCalls = [];
    newSessionOptions = [];
    loadSessionCalls = [];
    failNewSession = false;
    releaseNewSession = null;
    configCalls = [];
    let newSessionConfig: ConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "agent-default-model",
        options: [
          { value: "agent-default-model", name: "Default" },
          { value: "inherited-model", name: "Inherited" },
        ],
      },
      {
        type: "select",
        id: "mode",
        name: "Mode",
        currentValue: "agent-mode",
        options: [
          { value: "agent-mode", name: "Agent" },
          { value: "autopilot-mode", name: "Autopilot" },
        ],
      },
      {
        type: "select",
        id: "reasoning_effort",
        name: "Reasoning",
        currentValue: "medium",
        options: [
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];
    const bridge = {
      ...mockBridgeStubs(),
      async newSession(cwd: string, opts?: { silent?: boolean }) {
        newSessionCalls.push(cwd);
        newSessionOptions.push(opts);
        if (failNewSession) throw new Error("agent create failed");
        if (releaseNewSession) {
          await new Promise<void>((resolve) => {
            const release = releaseNewSession;
            releaseNewSession = () => {
              release?.();
              resolve();
            };
          });
        }
        return {
          sessionId: `agent-session-${newSessionCalls.length}`,
          configOptions: newSessionConfig,
        };
      },
      async setConfigOption(
        sessionId: string,
        configId: string,
        value: string,
      ) {
        configCalls.push({ sessionId, configId, value });
        newSessionConfig = newSessionConfig.map((option) =>
          option.id === configId && "options" in option
            ? { ...option, currentValue: value }
            : option,
        );
        return newSessionConfig;
      },
      async loadSession(sessionId: string) {
        loadSessionCalls.push(sessionId);
        throw new Error("newly consumed sessions must already be live");
      },
    };
    const sseManager = new SseManager();
    broadcasts = [];
    const orig = sseManager.broadcast.bind(sseManager);
    sseManager.broadcast = (ev: AgentEvent) => {
      broadcasts.push(ev);
      orig(ev);
    };

    const handler = createRequestHandler({
      sseManager,
      store,
      sessions,
      getBridge: () => bridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    });
    server = http.createServer(handler);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkMsg(id: string): void {
    const cwd = join(tmpDir, "work");
    mkdirSync(cwd, { recursive: true });
    store.createMessage({
      id,
      from_ref: "cron:x",
      from_label: null,
      to_ref: "user",
      deliver: "push",
      dedup_key: null,
      title: "t",
      body: "b",
      cwd,
      created_at: Date.now(),
    });
  }

  // consume --------------------------------------------------------------

  it("consume creates a live ACP session, appends the message, and broadcasts", async () => {
    mkMsg("m1");
    const r = await send(port, "POST", "/api/v1/messages/m1/consume");
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.sessionId, "agent-session-1");
    assert.deepEqual(newSessionCalls, [join(tmpDir, "work")]);
    assert.deepEqual(newSessionOptions, [{ silent: true }]);

    // Row deleted
    assert.equal(store.getMessage("m1"), undefined);

    // Session exists
    const sess = store.getSession(body.sessionId);
    assert.ok(sess);
    assert.equal(sess.cwd, join(tmpDir, "work"));
    assert.equal(sess.source, "message");

    // Event written with message_id
    const events = store.getEvents(body.sessionId);
    const msgE = events.find((e) => e.type === "message");
    assert.ok(msgE);
    const data = JSON.parse(msgE.data) as Record<string, unknown>;
    assert.equal(data.message_id, "m1");

    // SSE fired
    const ev = broadcasts.find((e) => e.type === "message_consumed");
    assert.ok(ev, "message_consumed SSE");
    assert.equal(ev.messageId, "m1");
    assert.equal(ev.sessionId, body.sessionId);

    // Switching to the returned session must not attempt ACP loadSession.
    const get = await send(port, "GET", `/api/v1/sessions/${body.sessionId}`);
    assert.equal(get.status, 200);
    assert.deepEqual(loadSessionCalls, []);
  });

  it("reuses new-session config inheritance without inheriting mode", async () => {
    mkMsg("m-inherit");
    store.createSession("source-session", tmpDir);
    store.updateSessionConfig("source-session", "model", "inherited-model");
    store.updateSessionConfig("source-session", "mode", "autopilot-mode");
    store.updateSessionConfig("source-session", "reasoning_effort", "high");
    sessions.cachedConfigOptions = [
      {
        type: "select",
        id: "mode",
        name: "Mode",
        currentValue: "autopilot-mode",
        options: [
          { value: "agent-mode", name: "Agent" },
          { value: "autopilot-mode", name: "Autopilot" },
        ],
      },
    ];

    const consumed = await send(
      port,
      "POST",
      "/api/v1/messages/m-inherit/consume",
      { inheritFromSessionId: "source-session" },
    );

    assert.equal(consumed.status, 200);
    const sessionId = JSON.parse(consumed.body).sessionId as string;
    assert.deepEqual(configCalls, [
      { sessionId, configId: "model", value: "inherited-model" },
      { sessionId, configId: "reasoning_effort", value: "high" },
    ]);
    const stored = store.getSession(sessionId);
    assert.ok(stored);
    assert.equal(stored.model, "inherited-model");
    assert.equal(stored.reasoning_effort, "high");
    assert.equal(stored.mode, "agent-mode");

    const response = await send(port, "GET", `/api/v1/sessions/${sessionId}`);
    const detail = JSON.parse(response.body) as {
      configOptions: ConfigOption[];
    };
    const currentValues = Object.fromEntries(
      detail.configOptions.map((option) => [option.id, option.currentValue]),
    );
    assert.deepEqual(currentValues, {
      model: "inherited-model",
      mode: "agent-mode",
      reasoning_effort: "high",
    });
  });

  it("consume is idempotent: second call returns same sessionId, no new session", async () => {
    mkMsg("m2");
    const r1 = await send(port, "POST", "/api/v1/messages/m2/consume");
    const sid1 = JSON.parse(r1.body).sessionId;

    const r2 = await send(port, "POST", "/api/v1/messages/m2/consume");
    assert.equal(r2.status, 200);
    const sid2 = JSON.parse(r2.body).sessionId;
    assert.equal(sid2, sid1, "second consume returns same sessionId");

    // Only one message event across all sessions
    const allEvents = store.getEvents(sid1).filter((e) => e.type === "message");
    assert.equal(allEvents.length, 1);
    assert.equal(newSessionCalls.length, 1);
  });

  it("deduplicates concurrent consume requests before creating the ACP session", async () => {
    mkMsg("m-concurrent");
    releaseNewSession = () => {};

    const first = send(port, "POST", "/api/v1/messages/m-concurrent/consume");
    await waitFor(() => newSessionCalls.length > 0, {
      message: "consume did not start ACP session creation",
    });
    const second = send(port, "POST", "/api/v1/messages/m-concurrent/consume");
    releaseNewSession();

    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(JSON.parse(r1.body).sessionId, "agent-session-1");
    assert.equal(JSON.parse(r2.body).sessionId, "agent-session-1");
    assert.equal(newSessionCalls.length, 1);
    assert.equal(
      store
        .getEvents("agent-session-1")
        .filter((event) => event.type === "message").length,
      1,
    );
  });

  it("keeps the inbox row when ACP session creation fails", async () => {
    mkMsg("m-fail");
    failNewSession = true;

    const r = await send(port, "POST", "/api/v1/messages/m-fail/consume");

    assert.equal(r.status, 500);
    assert.ok(store.getMessage("m-fail"));
    assert.equal(
      store.listSessions({ source: "message" }).length,
      0,
      "no local shell session should be left behind",
    );
    assert.equal(
      broadcasts.some((event) => event.type === "message_consumed"),
      false,
    );

    failNewSession = false;
    const retry = await send(port, "POST", "/api/v1/messages/m-fail/consume");
    assert.equal(retry.status, 200);
    assert.equal(JSON.parse(retry.body).sessionId, "agent-session-2");
  });

  it("rolls back the local session when the message transaction fails", async () => {
    mkMsg("m-store-fail");
    store.consumeMessageTx = () => {
      throw new Error("database write failed");
    };

    const r = await send(port, "POST", "/api/v1/messages/m-store-fail/consume");

    assert.equal(r.status, 500);
    assert.ok(store.getMessage("m-store-fail"));
    assert.equal(store.getSession("agent-session-1"), undefined);
    assert.equal(sessions.liveSessions.has("agent-session-1"), false);
  });

  it("keeps the inbox row when its cwd no longer exists", async () => {
    store.createMessage({
      id: "m-bad-cwd",
      from_ref: "cron:x",
      from_label: null,
      to_ref: "user",
      deliver: "push",
      dedup_key: null,
      title: "t",
      body: "b",
      cwd: join(tmpDir, "missing"),
      created_at: Date.now(),
    });

    const r = await send(port, "POST", "/api/v1/messages/m-bad-cwd/consume");

    assert.equal(r.status, 400);
    assert.ok(store.getMessage("m-bad-cwd"));
    assert.equal(newSessionCalls.length, 0);
  });

  it("uses the configured default cwd when the message has no cwd", async () => {
    store.createMessage({
      id: "m-default-cwd",
      from_ref: "cron:x",
      from_label: null,
      to_ref: "user",
      deliver: "push",
      dedup_key: null,
      title: "t",
      body: "b",
      cwd: null,
      created_at: Date.now(),
    });

    const r = await send(
      port,
      "POST",
      "/api/v1/messages/m-default-cwd/consume",
    );

    assert.equal(r.status, 200);
    assert.deepEqual(newSessionCalls, [tmpDir]);
    assert.equal(store.getSession("agent-session-1")?.cwd, tmpDir);
  });

  it("consume of unknown id returns 404", async () => {
    const r = await send(port, "POST", "/api/v1/messages/nope/consume");
    assert.equal(r.status, 404);
  });

  // ack / DELETE ---------------------------------------------------------

  it("ack deletes row, broadcasts message_acked", async () => {
    mkMsg("m3");
    const r = await send(port, "POST", "/api/v1/messages/m3/ack");
    assert.equal(r.status, 200);
    assert.equal(store.getMessage("m3"), undefined);

    const ev = broadcasts.find((e) => e.type === "message_acked");
    assert.ok(ev);
    assert.equal(ev.messageId, "m3");
  });

  it("DELETE /api/v1/messages/:id is an alias for ack", async () => {
    mkMsg("m4");
    const r = await send(port, "DELETE", "/api/v1/messages/m4");
    assert.equal(r.status, 200);
    assert.equal(store.getMessage("m4"), undefined);
    assert.ok(broadcasts.find((e) => e.type === "message_acked"));
  });

  it("ack of unknown id returns 404", async () => {
    const r = await send(port, "POST", "/api/v1/messages/nope/ack");
    assert.equal(r.status, 404);
  });
});
