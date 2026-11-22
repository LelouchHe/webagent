import assert from "node:assert/strict";
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

test("behavior proof: host client connects, sends in edge order, and removes on typed 404", async (t) => {
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
  const first = store.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "first",
  });
  const second = store.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "second",
  });
  const requests: string[] = [];
  const bodies: string[] = [];
  let dispatchCount = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"connected","clientId":"host-client"}\n\n',
        ),
      );
    },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requests.push(url);
    if (url.endsWith("/api/v1/host") && (init?.method ?? "GET") === "GET") {
      return Response.json({ host_api_version: 1, agent_ids: ["copilot"] });
    }
    if (url.endsWith("/api/v1/sse-ticket")) {
      return Response.json({ ticket: "ticket" });
    }
    if (url.includes("/api/v1/events/stream")) {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (url.endsWith("/api/v1/host/messages") && init?.method === "GET") {
      return Response.json({ messages: [] });
    }
    if (url.endsWith("/api/v1/host/messages") && init?.method === "POST") {
      dispatchCount += 1;
      if (typeof init.body !== "string") {
        assert.fail("host dispatch body must be JSON text");
      }
      bodies.push(init.body);
      if (dispatchCount === 2) {
        return Response.json(
          { error: "Host task not found", code: "target_not_found" },
          { status: 404 },
        );
      }
      return Response.json({ accepted: true }, { status: 202 });
    }
    return new Response("unknown", { status: 404 });
  };
  const tasks = createTaskManager(store, dir, dir);
  const registry = new HostRegistry(
    {
      mini: {
        url: "http://mini.invalid",
        token: "wat_test_token",
      },
    },
    store,
    tasks,
    { fetch: fetchImpl, sleep: async () => {} },
  );
  registry.start();
  t.after(() => {
    registry.stop();
    tasks.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(() => dispatchCount === 2, { timeoutMs: 2000 });
  assert.equal(
    store.getCollaborationDelivery(first.delivery.id)?.status,
    "delivered",
  );
  assert.equal(
    store.getCollaborationDelivery(second.delivery.id)?.failure_reason,
    "target_removed",
  );
  assert.equal(store.getHostEdge(edge.edge.id)?.status, "removed");
  assert.equal(store.countQueuedDeliveries(parent.id), 1);
  assert.deepEqual(
    bodies.map((body) => (JSON.parse(body) as { body: string }).body),
    ["first", "second"],
  );
  assert.ok(requests.some((url) => url.endsWith("/api/v1/host")));
  assert.ok(requests.some((url) => url.includes("/api/v1/events/stream")));
});

test("behavior proof: 400 and 409 terminalize without a target notice", () => {
  const dir = mkdtempSync(join(tmpdir(), "webagent-host-terminal-"));
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
  const tasks = createTaskManager(store, dir, dir);
  const edge = store.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId: "remote",
    title: "remote",
    credentialHash: "3".repeat(64),
    createKey: "terminal",
    requestHash: "terminal",
    event: {
      title: "remote",
      body: "remote",
      kind: "task_created_remote",
      taskId: "remote",
      taskTitle: "remote",
      agentId: "copilot",
      cwd: dir,
      model: null,
      thinking: null,
    },
  });
  assert.ok(edge.edge);
  for (const reason of ["http_400", "http_409"]) {
    const dispatch = store.createRemoteDispatch({
      parentTaskId: parent.id,
      edge: edge.edge,
      body: reason,
    });
    store.finishHostDispatch(dispatch.delivery.id, reason);
    assert.equal(
      store.getCollaborationDelivery(dispatch.delivery.id)?.status,
      "failed",
    );
  }
  assert.equal(store.countQueuedDeliveries(parent.id), 0);
  assert.equal(store.getHostEdge(edge.edge.id)?.status, "active");
  tasks.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
