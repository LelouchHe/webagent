import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import { HostStore } from "../src/host/store.ts";
import { TaskLocator } from "../src/task-locator.ts";

test("behavior proof: MCP create and send address a remote child by returned task id", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "webagent-host-mcp-"));
  const store = new Store(dir);
  const root = store.ensureRootTask(dir);
  const hostStore = new HostStore(store);
  const tasks = createTaskManager(
    store,
    dir,
    dir,
    undefined,
    undefined,
    "test-agent",
    new TaskLocator(store, [hostStore]),
  );
  store.createTask(
    "parent",
    dir,
    "agent",
    "test-agent",
    "session-parent",
    root.id,
  );
  const kicks: string[] = [];
  let committedMessageId: string | null = null;
  const crossHostCreator = {
    async create(input: { agent: string }) {
      if (input.agent !== "copilot@mini") return { handled: false };
      const edge = hostStore.createHostEdge({
        parentTaskId: "parent",
        hostName: "mini",
        remoteTaskId: "remote-child-id",
        title: "build",
        credentialHash: "a".repeat(64),
        createKey: "create",
        requestHash: "create",
        event: {
          title: "remote",
          body: "remote",
          kind: "task_created_remote",
          taskId: "remote-child-id",
          taskTitle: "build",
          agentId: "copilot",
          cwd: "owner",
          model: null,
          thinking: null,
        },
      });
      assert.equal(edge.status, "created");
      return { handled: true, taskId: "remote-child-id" };
    },
  };
  tasks.onDeliveriesCommitted((delivery) => {
    committedMessageId = delivery.messageId;
    const action = hostStore.deliveryCommitAction(delivery.deliveryId);
    if (action && "edgeId" in action) kicks.push(action.edgeId);
  });
  const host = createMcpTaskToolHost({
    store,
    tasks,
    crossHostCreator,
  });
  const lease = tasks.authority.leaseFor("parent");
  assert.ok(lease);
  const principal = {
    taskId: "parent",
    agentId: "test-agent",
    generation: lease.generation,
    initializing: false,
  };
  t.after(() => {
    tasks.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return host
    .create(principal, { title: "build", agent: "copilot@mini" })
    .then(async (created) => {
      assert.equal(created.taskId, "remote-child-id");
      const remote = host
        .list(principal)
        .find((item) => item.id === "remote-child-id");
      assert.equal(remote?.relation, "child");
      assert.equal(remote.external, true);

      await host.send(principal, created.taskId, "run");
      const dispatch = hostStore.nextHostDispatch(
        hostStore.listHostEdgesForParent("parent")[0].id,
      );
      assert.ok(dispatch);
      assert.equal(dispatch.message.body, "run");
      assert.equal(dispatch.message.id, committedMessageId);
      const audit = store
        .getEvents("parent")
        .map((event) => JSON.parse(event.data) as Record<string, unknown>)
        .find((data) => data.kind === "collaboration" && data.body === "run");
      assert.equal(audit?.messageId, committedMessageId);
      assert.equal(kicks.length, 1);
    });
});
