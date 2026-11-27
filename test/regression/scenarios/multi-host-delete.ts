import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenario, type Json, type JsonObject } from "../types.ts";
import {
  EMPTY_MOCK,
  hostTokenPath,
  provisionHostToken,
  waitForHost,
} from "../multi-host.ts";

interface State {
  rootId: string;
  parentId: string;
  partialParentId: string;
  recurseParentId: string;
  ownerDeleteParentId: string;
  ownerDb: string;
  hubDb: string;
}

function readRows(dbPath: string, sql: string): Json {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as Json;
  } finally {
    db.close();
  }
}

function readTaskId(dbPath: string, title: string): string {
  const rows = readRows(
    dbPath,
    `SELECT id FROM tasks WHERE title = '${title.replace(/'/g, "''")}'`,
  );
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (
    !first ||
    typeof first !== "object" ||
    typeof (first as JsonObject).id !== "string"
  ) {
    throw new Error(`task missing (${title}): ${JSON.stringify(rows)}`);
  }
  return (first as JsonObject).id as string;
}

async function waitForRows(dbPath: string, sql: string): Promise<Json> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const rows = readRows(dbPath, sql);
    if (Array.isArray(rows) && rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`rows did not arrive: ${sql}`);
}

async function waitForExecutionState(
  inst: {
    rest(
      method: string,
      path: string,
      body?: Json,
    ): Promise<{ status: number; body: Json }>;
  },
  taskId: string,
  expected: string,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const res = await inst.rest("GET", `/api/v1/tasks/${taskId}/status`);
    if ((res.body as JsonObject).executionState === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${taskId} did not reach executionState=${expected}`);
}

async function waitSettled(state: State): Promise<void> {
  const ownerMax = (
    readRows(
      state.ownerDb,
      `SELECT COALESCE(MAX(pos), 0) AS pos FROM outbox WHERE remote_role = 'parent'`,
    ) as Array<{ pos: number }>
  )[0].pos;
  await waitForRows(
    state.hubDb,
    `SELECT 1 WHERE COALESCE((SELECT applied_pos FROM outbox_cursors WHERE remote_role = 'child' AND remote_host = 'owner'), 0) >= ${ownerMax}`,
  );
  await waitForRows(
    state.hubDb,
    `SELECT 1 WHERE COALESCE((SELECT pushed_pos FROM outbox_cursors WHERE remote_role = 'child' AND remote_host = 'owner'), 0)
       >= COALESCE((SELECT MAX(pos) FROM outbox WHERE remote_role = 'child' AND remote_host = 'owner'), 0)`,
  );
}

export default scenario<State>({
  mock: EMPTY_MOCK,
  forwarders: {
    link: {
      target: "owner",
      postPath: "/api/v1/link/entries",
      watchPath: "/api/v1/link/watch",
    },
  },
  instances: {
    owner: {
      mock: {
        prompts: [
          {
            match: "hold busy worker",
            actions: [
              { type: "wait", label: "busy-worker" },
              { type: "reply", text: "Busy worker finished." },
            ],
          },
          {
            match: "queue ordinary then stay armed",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$promptSourceTaskId",
                      body: "last note before delete",
                    },
                  },
                  {
                    tool: "task_update",
                    arguments: {
                      status: "waiting",
                      body: "still working",
                    },
                  },
                ],
              },
              { type: "reply", text: "Queued ordinary note." },
            ],
          },
          {
            match: "hold partial second",
            actions: [
              { type: "wait", label: "partial-second" },
              { type: "reply", text: "Second finished." },
            ],
          },
          {
            match: "create leaf back on hub",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Hop Leaf",
                      agent: "mock",
                      host: "hub",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created hop leaf." },
            ],
          },
          {
            match: "dispatch hop leaf busy",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Hop Leaf",
                      body: "hold hop leaf",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched hop leaf." },
            ],
          },
        ],
      },
      extraConfig: (instances) => [
        "[hosts.hub]",
        `url = ${JSON.stringify(instances.hub.origin)}`,
        `token = ${JSON.stringify(`!cat ${join(instances.owner.root, "hub-token")}`)}`,
      ],
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create busy child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Busy Child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created busy child." },
            ],
          },
          {
            match: "dispatch busy child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Busy Child",
                      body: "hold busy worker",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched busy child." },
            ],
          },
          {
            match: "create partial children",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Partial First",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Partial Second",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created partial children." },
            ],
          },
          {
            match: "arm partial first",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Partial Second",
                      body: "queue ordinary then stay armed",
                    },
                  },
                ],
              },
              { type: "reply", text: "Armed partial first." },
            ],
          },
          {
            match: "dispatch partial second",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Partial First",
                      body: "hold partial second",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched partial second." },
            ],
          },
          {
            match: "last note before delete",
            actions: [{ type: "reply", text: "Noted ordinary message." }],
          },
          {
            match: "left this edge",
            actions: [{ type: "reply", text: "Noted target removed." }],
          },
          {
            match: "create hop middle",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Hop Mid",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created hop middle." },
            ],
          },
          {
            match: "hold hop leaf",
            actions: [
              { type: "wait", label: "hop-leaf" },
              { type: "reply", text: "Hop leaf done." },
            ],
          },
          {
            match: "create owner delete child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Owner Deleted Child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created owner delete child." },
            ],
          },
          {
            match: "list children after owner delete",
            actions: [
              {
                type: "mcp",
                calls: [{ tool: "task_list", arguments: {} }],
              },
              { type: "reply", text: "Listed children." },
            ],
          },
        ],
      },
      extraConfig: (instances) => [
        "[hosts.owner]",
        `url = ${JSON.stringify(instances.hub.forwarders.link)}`,
        `token = ${JSON.stringify(`!cat ${hostTokenPath(instances)}`)}`,
      ],
    },
  },
  async setup(ctx) {
    await provisionHostToken(ctx, { scope: "host" });
    const hubTokRes = await ctx.instance("hub").rest("POST", "/api/v1/tokens", {
      name: "owner-connection",
      scope: "host",
    });
    const hubTokBody = hubTokRes.body as JsonObject;
    if (hubTokRes.status !== 201 || typeof hubTokBody.token !== "string") {
      throw new Error(`hub token create failed: ${JSON.stringify(hubTokRes)}`);
    }
    writeFileSync(
      join(ctx.instances.owner.root, "hub-token"),
      hubTokBody.token,
    );
    await waitForHost(ctx, "owner", "hub", "connected");
    const bootstrapped = await ctx
      .instance("hub")
      .rest("POST", "/api/v1/tasks/bootstrap");
    const rootId = (bootstrapped.body as JsonObject).id as string;
    return {
      rootId,
      parentId: "",
      partialParentId: "",
      recurseParentId: "",
      ownerDeleteParentId: "",
      ownerDb: join(ctx.instances.owner.root, "data", "webagent.db"),
      hubDb: join(ctx.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps: () => [
    {
      name: "s1-busy-remote-child-blocks-parent-delete-then-succeeds-idle",
      action: async (client, state) => {
        const created = await client
          .instance("hub")
          .rest("POST", "/api/v1/tasks", {
            title: "Busy Parent",
            parentId: state.rootId,
          });
        state.parentId = (created.body as JsonObject).id as string;

        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
            text: "create busy child",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'prompt_done'`,
        );
        const busyChildId = readTaskId(state.ownerDb, "Busy Child");
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
            text: "dispatch busy child",
          });
        await waitForExecutionState(
          client.instance("owner"),
          busyChildId,
          "agent",
        );

        // Deleting parent while remote child is busy -> 409, both preserved.
        const blocked = await client
          .instance("hub")
          .rest("DELETE", `/api/v1/tasks/${state.parentId}`);
        const parentStillThere = readRows(
          state.hubDb,
          `SELECT COUNT(*) AS count FROM tasks WHERE id = '${state.parentId}'`,
        );
        const childStillThere = readRows(
          state.ownerDb,
          `SELECT COUNT(*) AS count FROM tasks WHERE id = '${busyChildId}'`,
        );

        // Cancel busy child so it becomes idle, then retry delete -> 200, both deleted.
        await client
          .instance("owner")
          .rest("POST", `/api/v1/tasks/${busyChildId}/cancel`);
        await waitForExecutionState(
          client.instance("owner"),
          busyChildId,
          "idle",
        );
        const deleted = await client
          .instance("hub")
          .rest("DELETE", `/api/v1/tasks/${state.parentId}`);
        await waitSettled(state);
        return {
          blockedStatus: blocked.status,
          blockedOutcome: (blocked.body as JsonObject).outcome,
          parentStillThere,
          childStillThere,
          deletedStatus: deleted.status,
          parentAfter: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM tasks WHERE id = '${state.parentId}'`,
          ),
          childAfter: readRows(
            state.ownerDb,
            `SELECT COUNT(*) AS count FROM tasks WHERE id = '${busyChildId}'`,
          ),
        };
      },
    },
    {
      name: "s2-partial-delete-preserves-queued-message-and-cleans-via-child-left",
      action: async (client, state) => {
        const link = client.forwarder("link");
        const created = await client
          .instance("hub")
          .rest("POST", "/api/v1/tasks", {
            title: "Partial Parent",
            parentId: state.rootId,
          });
        state.partialParentId = (created.body as JsonObject).id as string;

        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.partialParentId}/prompt`, {
            text: "create partial children",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.partialParentId}' AND type = 'prompt_done'`,
        );
        const firstId = readTaskId(state.ownerDb, "Partial Second");
        const secondId = readTaskId(state.ownerDb, "Partial First");

        // Hold owner -> hub feed so first child's queued message + child_left wait.
        link.disconnect("watch");
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.partialParentId}/prompt`, {
            text: "arm partial first",
          });
        await waitForRows(
          state.ownerDb,
          `SELECT 1 FROM events WHERE task_id = '${firstId}' AND type = 'prompt_done'`,
        );
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.partialParentId}/prompt`, {
            text: "dispatch partial second",
          });
        await waitForExecutionState(
          client.instance("owner"),
          secondId,
          "agent",
        );

        // Ensure deterministic order: firstId is deleted, secondId is busy.
        const partial = await client
          .instance("hub")
          .rest("DELETE", `/api/v1/tasks/${state.partialParentId}`);
        // While watch is still held, hub must still retain firstId's child row
        // (200 does not delete child row early).
        const linksWhileHeld = readRows(
          state.hubDb,
          `SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = '${state.partialParentId}' AND remote_role = 'child'`,
        );

        // Resume watch: firstId's previously queued message arrives, target_removed
        // fires once, and child_left removes firstId's row while P is preserved.
        link.connect("watch");
        await waitSettled(state);
        const linksAfterChildLeft = readRows(
          state.hubDb,
          `SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = '${state.partialParentId}' AND remote_role = 'child'`,
        );
        const noticesAfterChildLeft = readRows(
          state.hubDb,
          `SELECT json_extract(data, '$.reason') AS reason FROM events
             WHERE task_id = '${state.partialParentId}' AND type = 'task_outcome_notice'`,
        );
        const ordinaryDelivered = readRows(
          state.hubDb,
          `SELECT COUNT(*) AS count FROM messages m JOIN deliveries d ON d.message_id = m.id
             WHERE d.recipient_task_id = '${state.partialParentId}' AND m.body = 'last note before delete'`,
        );

        // Release second child and retry delete -> succeeds cleanly.
        await client
          .instance("owner")
          .rest("POST", `/api/v1/tasks/${secondId}/cancel`);
        await waitForExecutionState(client.instance("owner"), secondId, "idle");
        const retry = await client
          .instance("hub")
          .rest("DELETE", `/api/v1/tasks/${state.partialParentId}`);
        await waitSettled(state);
        return {
          partialStatus: partial.status,
          linksWhileHeld,
          linksAfterChildLeft,
          noticesAfterChildLeft,
          ordinaryDelivered,
          retryStatus: retry.status,
          parentAfterRetry: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM tasks WHERE id = '${state.partialParentId}'`,
          ),
          secondAfterRetry: readRows(
            state.ownerDb,
            `SELECT COUNT(*) AS count FROM tasks WHERE id = '${secondId}'`,
          ),
        };
      },
    },
    {
      name: "s3-two-hop-recursive-delete-a-to-b-to-a",
      action: async (client, state) => {
        const created = await client
          .instance("hub")
          .rest("POST", "/api/v1/tasks", {
            title: "Recurse Parent",
            parentId: state.rootId,
          });
        state.recurseParentId = (created.body as JsonObject).id as string;

        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.recurseParentId}/prompt`, {
            text: "create hop middle",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.recurseParentId}' AND type = 'prompt_done'`,
        );
        const midId = readTaskId(state.ownerDb, "Hop Mid");
        await client
          .instance("owner")
          .rest("POST", `/api/v1/tasks/${midId}/prompt`, {
            text: "create leaf back on hub",
          });
        await waitForRows(
          state.ownerDb,
          `SELECT 1 FROM events WHERE task_id = '${midId}' AND type = 'prompt_done'`,
        );
        const leafId = readTaskId(state.hubDb, "Hop Leaf");

        await client
          .instance("owner")
          .rest("POST", `/api/v1/tasks/${midId}/prompt`, {
            text: "dispatch hop leaf busy",
          });
        await waitForExecutionState(client.instance("hub"), leafId, "agent");

        // Second hop busy -> middle owner returns typed 4xx, top-level preserves P.
        const blocked = await client
          .instance("hub")
          .rest("DELETE", `/api/v1/tasks/${state.recurseParentId}`);
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${leafId}/cancel`);
        await waitForExecutionState(client.instance("hub"), leafId, "idle");

        // Now delete top-level -> deletes leaf, mid, and parent.
        const deleted = await client
          .instance("hub")
          .rest("DELETE", `/api/v1/tasks/${state.recurseParentId}`);
        await waitSettled(state);
        return {
          blockedStatus: blocked.status,
          blockedOutcome: (blocked.body as JsonObject).outcome,
          deletedStatus: deleted.status,
          leafAfter: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM tasks WHERE id = '${leafId}'`,
          ),
          midAfter: readRows(
            state.ownerDb,
            `SELECT COUNT(*) AS count FROM tasks WHERE id = '${midId}'`,
          ),
          parentAfter: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM tasks WHERE id = '${state.recurseParentId}'`,
          ),
        };
      },
    },
    {
      name: "s4-owner-delete-removes-hub-child-row-via-child-left",
      action: async (client, state) => {
        const created = await client
          .instance("hub")
          .rest("POST", "/api/v1/tasks", {
            title: "Owner Delete Parent",
            parentId: state.rootId,
          });
        state.ownerDeleteParentId = (created.body as JsonObject).id as string;

        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.ownerDeleteParentId}/prompt`, {
            text: "create owner delete child",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.ownerDeleteParentId}' AND type = 'prompt_done'`,
        );
        const childId = readTaskId(state.ownerDb, "Owner Deleted Child");
        const deleted = await client
          .instance("owner")
          .rest("DELETE", `/api/v1/tasks/${childId}`);
        await waitSettled(state);
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.ownerDeleteParentId}/prompt`, {
            text: "list children after owner delete",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.ownerDeleteParentId}' AND type = 'prompt_done' AND seq > 2`,
        );
        return {
          deletedStatus: deleted.status,
          hubLinksRemaining: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = '${state.ownerDeleteParentId}'`,
          ),
        };
      },
    },
  ],
});
