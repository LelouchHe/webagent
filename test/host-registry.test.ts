import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.ts";
import { HostRegistry, resolveSecret } from "../src/host-registry.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { waitFor } from "./fixtures.ts";
import { hashToken } from "../src/auth.ts";

test("behavior proof: token commands resolve with a timeout and redact failure", async () => {
  assert.equal(await resolveSecret("literal-token"), "literal-token");
  assert.equal(
    await resolveSecret("!printf ' command-token '"),
    "command-token",
  );
  await assert.rejects(resolveSecret("!sleep 1", 5), {
    name: "SecretResolutionError",
    message: "token resolution failed",
  });
});

test("behavior proof: transport safely classifies real rejection, 503, 400, 409, and typed 404 in order", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "webagent-host-client-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  const parent = store.createTask(
    "parent",
    dir,
    "agent",
    "test-agent",
    "session-parent",
    store.rootTaskId,
  );
  const edge = store.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId: "remote-child",
    title: "remote",
    credentialHash: hashToken("wat_test_token"),
    createKey: "edge",
    requestHash: "request",
    event: {
      title: "remote",
      body: "remote",
      kind: "task_created_remote",
      taskId: "remote-child",
      taskTitle: "remote",
      agentId: "copilot",
      cwd: "/owner",
      model: null,
      thinking: null,
    },
  });
  assert.ok(edge.edge);
  const retried = store.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "network",
  });
  const badRequest = store.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "bad-400",
  });
  const conflict = store.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "bad-409",
  });
  const removed = store.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "removed",
  });
  const later = store.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "later",
  });
  const bodies: string[] = [];
  let networkAttempts = 0;
  const owner = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/host") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ host_api_version: 1, agent_ids: ["copilot"] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/sse-ticket") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ticket: "ticket" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/v1/events/stream")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.write('data: {"type":"connected","clientId":"host-client"}\n\n');
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/host/messages") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/host/messages") {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const body = (JSON.parse(raw) as { body: string }).body;
        bodies.push(body);
        if (body === "network") {
          networkAttempts += 1;
          if (networkAttempts === 1) {
            req.socket.destroy();
            return;
          }
          if (networkAttempts === 2) {
            res.writeHead(503);
            res.end();
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
          return;
        }
        if (body === "bad-400") {
          res.writeHead(400);
          res.end();
          return;
        }
        if (body === "bad-409") {
          res.writeHead(409);
          res.end();
          return;
        }
        if (body === "removed") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Host task not found",
              code: "target_not_found",
            }),
          );
          return;
        }
        res.writeHead(202);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
  const ownerPort = (owner.address() as { port: number }).port;
  const tasks = createTaskManager(store, dir, dir);
  const registry = new HostRegistry(
    {
      mini: {
        url: `http://127.0.0.1:${ownerPort}`,
        token: "wat_test_token",
      },
    },
    store,
    tasks,
  );
  registry.start();
  t.after(async () => {
    registry.stop();
    tasks.dispose();
    await new Promise<void>((resolve) => {
      owner.closeAllConnections();
      owner.close(() => {
        resolve();
      });
    });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(() => registry.state("mini")?.status === "unreachable", {
    timeoutMs: 1_000,
  });
  await waitFor(() => bodies.includes("removed"), { timeoutMs: 5_000 });
  assert.equal(
    store.getCollaborationDelivery(retried.delivery.id)?.status,
    "delivered",
  );
  assert.equal(
    store.getCollaborationDelivery(badRequest.delivery.id)?.failure_reason,
    "http_400",
  );
  assert.equal(
    store.getCollaborationDelivery(conflict.delivery.id)?.failure_reason,
    "http_409",
  );
  assert.equal(
    store.getCollaborationDelivery(removed.delivery.id)?.failure_reason,
    "target_removed",
  );
  assert.equal(
    store.getCollaborationDelivery(later.delivery.id)?.failure_reason,
    "target_removed_edge",
  );
  assert.equal(store.getHostEdge(edge.edge.id)?.status, "removed");
  assert.equal(store.countQueuedDeliveries(parent.id), 1);
  assert.deepEqual(bodies, [
    "network",
    "network",
    "network",
    "bad-400",
    "bad-409",
    "removed",
  ]);
  const notices = store
    .getEvents(parent.id)
    .filter((event) => event.type === "task_outcome_notice");
  assert.equal(notices.length, 1);
  assert.equal(JSON.parse(notices[0].data).reason, "target_removed");
  assert.equal(registry.state("mini")?.status, "ok");
  assert.ok(networkAttempts === 3);
});

test("behavior proof: an ACK lost in flight stays dirty without bypassing backoff", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "webagent-host-ack-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  const parent = store.createTask(
    "parent",
    dir,
    "agent",
    "test-agent",
    "session-parent",
    store.rootTaskId,
  );
  const edge = store.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId: "remote-child",
    title: "remote",
    credentialHash: hashToken("wat_test_token"),
    createKey: "ack-edge",
    requestHash: "ack-edge",
    event: {
      title: "remote",
      body: "remote",
      kind: "task_created_remote",
      taskId: "remote-child",
      taskTitle: "remote",
      agentId: "copilot",
      cwd: dir,
      model: null,
      thinking: null,
    },
  });
  assert.ok(edge.edge);
  let getCount = 0;
  let acked = false;
  let streamResponse: import("node:http").ServerResponse | null = null;
  const owner = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/host") {
      res.end(JSON.stringify({ host_api_version: 1, agent_ids: ["copilot"] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/sse-ticket") {
      res.end(JSON.stringify({ ticket: "ticket" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/v1/events/stream")) {
      streamResponse = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"type":"connected","clientId":"host-client"}\n\n');
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/host/messages") {
      getCount += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          messages: acked
            ? []
            : [
                {
                  id: "owner-message",
                  owner_task_id: "remote-child",
                  parent_task_id: parent.id,
                  kind: "blocked",
                  body: "needs input",
                  runtime_kind: null,
                  reason: null,
                  queued_at: Date.now(),
                },
              ],
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/api/v1/host/messages/owner-message/ack"
    ) {
      acked = true;
      setTimeout(() => {
        streamResponse?.write('data: {"type":"host_message_pending"}\n\n');
      }, 10);
      setTimeout(() => req.socket.destroy(), 50);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
  const ownerPort = (owner.address() as { port: number }).port;
  const tasks = createTaskManager(store, dir, dir);
  const registry = new HostRegistry(
    {
      mini: {
        url: `http://127.0.0.1:${ownerPort}`,
        token: "wat_test_token",
      },
    },
    store,
    tasks,
  );
  registry.start();
  t.after(async () => {
    registry.stop();
    tasks.dispose();
    await new Promise<void>((resolve) => {
      owner.closeAllConnections();
      owner.close(() => {
        resolve();
      });
    });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(() => acked, { timeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    getCount,
    1,
    "hint and dirty state do not bypass an ACK-failure backoff",
  );
  await waitFor(() => getCount === 2, { timeoutMs: 2_000 });
  assert.equal(
    store.countQueuedDeliveries(parent.id),
    1,
    "duplicate fetch did not duplicate the local report",
  );
  const reportRecipients = store.queuedAckedHostReportRecipients();
  assert.deepEqual(reportRecipients, [parent.id]);
});
