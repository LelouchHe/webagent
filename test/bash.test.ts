import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { AgentEvent, ConfigOption } from "../src/types.ts";
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
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function createMockBridge() {
  const configOptions: ConfigOption[] = [];
  let idCounter = 0;
  return {
    ...mockBridgeStubs(),
    newSession: async () => {
      idCounter++;
      return `mock-session-${idCounter}`;
    },
    loadSession: async () => ({ sessionId: "", configOptions }),
    setConfigOption: async () => configOptions,
    cancel: async () => {},
    prompt: async () => {},
    resolvePermission: async () => {},
    denyPermission: async () => {},
  };
}

/** Wait until the condition returns true, polling every interval ms. */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 5000,
  interval = 50,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe("Bash REST API", () => {
  let store: Store;
  let sessions: SessionManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;
  let broadcastEvents: AgentEvent[];
  let mockSseManager: { broadcast: (event: AgentEvent) => void };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-bash-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(join(tmpDir, "test.db"));
    sessions = new SessionManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();
    broadcastEvents = [];
    mockSseManager = {
      broadcast: (event: AgentEvent) => broadcastEvents.push(event),
    };

    const handler = createRequestHandler({
      store,
      sessions,
      sseManager: mockSseManager as any,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    // Kill any remaining bash procs
    for (const [, proc] of sessions.runningBashProcs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

  describe("POST /api/v1/sessions/:id/bash", () => {
    it("accepts a command and returns 202", async () => {
      const id = await createSession();
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "echo hello" }),
      );
      assert.equal(res.status, 202);
      assert.deepEqual(JSON.parse(res.body), { status: "accepted" });
      // Wait for process to finish
      await waitFor(() => !sessions.runningBashProcs.has(id));
    });

    it("stores bash_command event", async () => {
      const id = await createSession();
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "echo stored" }),
      );
      await waitFor(() => !sessions.runningBashProcs.has(id));

      const events = store.getEvents(id);
      const bashCmd = events.find((e) => e.type === "bash_command");
      assert.ok(bashCmd);
      assert.equal(JSON.parse(bashCmd.data).command, "echo stored");
    });

    it("broadcasts bash_command event", async () => {
      const id = await createSession();
      broadcastEvents = [];
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "echo bc" }),
      );

      const cmdEvt = broadcastEvents.find(
        (e: any) => e.type === "bash_command",
      );
      assert.ok(cmdEvt);
      assert.equal((cmdEvt as any).command, "echo bc");
      await waitFor(() => !sessions.runningBashProcs.has(id));
    });

    it("broadcasts bash_output and bash_done events", async () => {
      const id = await createSession();
      broadcastEvents = [];
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "echo hello_world" }),
      );
      await waitFor(() => !sessions.runningBashProcs.has(id));

      const outputEvts = broadcastEvents.filter(
        (e: any) => e.type === "bash_output",
      );
      assert.ok(outputEvts.length > 0);
      const allText = outputEvts.map((e: any) => e.text).join("");
      assert.ok(allText.includes("hello_world"));

      const doneEvts = broadcastEvents.filter(
        (e: any) => e.type === "bash_done",
      );
      assert.equal(doneEvts.length, 1);
      assert.equal((doneEvts[0] as any).code, 0);
    });

    it("stores bash_result event on completion", async () => {
      const id = await createSession();
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "echo result_test" }),
      );
      await waitFor(() => !sessions.runningBashProcs.has(id));

      const events = store.getEvents(id);
      const result = events.find((e) => e.type === "bash_result");
      assert.ok(result);
      const data = JSON.parse(result.data);
      assert.ok(data.output.includes("result_test"));
      assert.equal(data.code, 0);
    });

    it("reports session as busy with bash", async () => {
      const id = await createSession();
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "sleep 5" }),
      );

      // Check status shows busy
      const statusRes = await makeRequest(
        port,
        "GET",
        `/api/v1/sessions/${id}/status`,
      );
      const status = JSON.parse(statusRes.body);
      assert.equal(status.busy, true);
      assert.equal(status.busyKind, "bash");

      // Cancel so afterEach cleanup isn't needed
      await makeRequest(port, "POST", `/api/v1/sessions/${id}/bash/cancel`);
      await waitFor(() => !sessions.runningBashProcs.has(id));
    });

    it("returns 409 when bash is already running", async () => {
      const id = await createSession();
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "sleep 5" }),
      );

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "echo second" }),
      );
      assert.equal(res.status, 409);

      await makeRequest(port, "POST", `/api/v1/sessions/${id}/bash/cancel`);
      await waitFor(() => !sessions.runningBashProcs.has(id));
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions/nonexistent/bash",
        JSON.stringify({ command: "echo hi" }),
      );
      assert.equal(res.status, 404);
    });

    it("returns 400 for missing command", async () => {
      const id = await createSession();
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({}),
      );
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const id = await createSession();
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        "not json",
      );
      assert.equal(res.status, 400);
    });

    it("handles non-zero exit code", async () => {
      const id = await createSession();
      broadcastEvents = [];
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "exit 42" }),
      );
      await waitFor(() => !sessions.runningBashProcs.has(id));

      const doneEvt = broadcastEvents.find((e: any) => e.type === "bash_done");
      assert.ok(doneEvt);
      assert.equal((doneEvt as any).code, 42);
    });
  });

  describe("POST /api/v1/sessions/:id/bash/cancel", () => {
    it("kills a running bash process", async () => {
      const id = await createSession();
      await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash`,
        JSON.stringify({ command: "sleep 60" }),
      );

      // Verify it's running
      assert.ok(sessions.runningBashProcs.has(id));

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash/cancel`,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });

      await waitFor(() => !sessions.runningBashProcs.has(id));
    });

    it("returns 200 even when no bash is running (idempotent)", async () => {
      const id = await createSession();
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/sessions/${id}/bash/cancel`,
      );
      assert.equal(res.status, 200);
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/sessions/nonexistent/bash/cancel",
      );
      assert.equal(res.status, 404);
    });
  });
});
