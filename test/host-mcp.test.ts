import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import type { HostRegistry } from "../src/host-registry.ts";

test("behavior proof: MCP create and send address a remote child by returned task id", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "webagent-host-mcp-"));
  const store = new Store(dir);
  const root = store.ensureRootTask(dir);
  const tasks = createTaskManager(store, dir, dir);
  store.createTask(
    "parent",
    dir,
    "agent",
    "test-agent",
    "session-parent",
    root.id,
  );
  const kicks: string[] = [];
  const registry = {
    remoteAgentId(value: string) {
      return value === "copilot@mini"
        ? {
            agentId: "copilot",
            hostName: "mini",
            credentialHash: "a".repeat(64),
          }
        : null;
    },
    async createTask() {
      return {
        taskId: "remote-child-id",
        credentialHash: "a".repeat(64),
      };
    },
    kick(edgeId: string) {
      kicks.push(edgeId);
    },
  } as unknown as HostRegistry;
  const host = createMcpTaskToolHost({ store, tasks, hosts: registry });
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
      const dispatch = store.nextHostDispatch(
        store.listHostEdgesForParent("parent")[0].id,
      );
      assert.equal(dispatch?.message.body, "run");
      assert.equal(kicks.length, 1);
    });
});
