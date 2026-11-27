import Database from "better-sqlite3";
import { join } from "node:path";
import { scenario, type Json, type JsonObject } from "../types.ts";
import {
  EMPTY_MOCK,
  hostTokenPath,
  provisionHostToken,
} from "../multi-host.ts";

interface State {
  parentId: string;
  parentTwoId: string;
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
            match: "send ordinary message to parent",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$promptSourceTaskId",
                      body: "ordinary hello from child",
                    },
                  },
                  {
                    tool: "task_query",
                    arguments: { task_id: "$promptSourceTaskId" },
                  },
                  {
                    tool: "task_read",
                    arguments: {
                      task_id: "$promptSourceTaskId",
                      seqs: [1],
                    },
                  },
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Ordinary message sent.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Sent ordinary message." },
            ],
          },
          {
            match: "report to deleted parent",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Late report for deleted parent.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Reported to deleted parent." },
            ],
          },
          {
            match: "report to live parent",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Live parent still receives reports.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Reported to live parent." },
            ],
          },
          {
            match: "ignore without updating",
            actions: [{ type: "reply", text: "Ignored turn." }],
          },
          {
            match: "hold open account for delete",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "waiting",
                      body: "Waiting while open account stays armed.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Account armed and idle." },
            ],
          },
          {
            match: "Runtime message:",
            actions: [{ type: "reply", text: "Owner child saw notice." }],
          },
        ],
      },
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create delivery children",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Delivery Child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Removable Child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created delivery children." },
            ],
          },
          {
            match: "create second parent child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Parent Two Child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created second parent child." },
            ],
          },
          {
            match: "dispatch deleted child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Removable Child",
                      body: "hello deleted child",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched deleted child." },
            ],
          },
          {
            match: "dispatch ordinary reverse",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Delivery Child",
                      body: "send ordinary message to parent",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched reverse send." },
            ],
          },
          {
            match: "dispatch live report",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Delivery Child",
                      body: "report to live parent",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched live report." },
            ],
          },
          {
            match: "dispatch no update",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Delivery Child",
                      body: "ignore without updating",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched no-update." },
            ],
          },
          {
            match: "dispatch arm for delete",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Delivery Child",
                      body: "hold open account for delete",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched arm for delete." },
            ],
          },
          {
            match: "ordinary hello from child",
            actions: [{ type: "reply", text: "Parent saw ordinary hello." }],
          },
          {
            match: "Task status: done",
            actions: [{ type: "reply", text: "Parent saw report." }],
          },
          {
            match: "Runtime message:",
            actions: [{ type: "reply", text: "Parent saw runtime notice." }],
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
  async setup(context) {
    await provisionHostToken(context, { scope: "host" });
    const bootstrapped = await context
      .instance("hub")
      .rest("POST", "/api/v1/tasks/bootstrap");
    const body = bootstrapped.body as JsonObject;
    if (typeof body.id !== "string") {
      throw new Error(`hub bootstrap failed: ${JSON.stringify(bootstrapped)}`);
    }
    const second = await context.instance("hub").rest("POST", "/api/v1/tasks", {
      title: "Parent Two",
      parentId: body.id,
    });
    const secondBody = second.body as JsonObject;
    if (typeof secondBody.id !== "string") {
      throw new Error(`second parent failed: ${JSON.stringify(second)}`);
    }
    return {
      parentId: body.id,
      parentTwoId: secondBody.id,
      ownerDb: join(context.instances.owner.root, "data", "webagent.db"),
      hubDb: join(context.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps(_client, state) {
    return [
      {
        name: "create-children",
        action: async (client) => {
          const r1 = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "create delivery children",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'prompt_done'`,
          );
          const r2 = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentTwoId}/prompt`, {
              text: "create second parent child",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentTwoId}' AND type = 'prompt_done'`,
          );
          return [r1, r2];
        },
      },
      {
        name: "s2-deleted-r1-notifies-p-once-with-target-deleted",
        action: async (client) => {
          const link = client.forwarder("link");
          const removableId = readTaskId(state.ownerDb, "Removable Child");
          // Hold the owner -> hub feed so the hub's in-flight send goes out
          // before child_left removes the link on hub.
          link.disconnect("watch");
          const deleted = await client
            .instance("owner")
            .rest("DELETE", `/api/v1/tasks/${removableId}`);
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch deleted child",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM outbox_cursors WHERE remote_role = 'child' AND remote_host = 'owner' AND pushed_pos >= 1`,
          );
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'prompt_done' AND seq > (SELECT seq FROM events WHERE task_id = '${state.parentId}' AND type = 'user_message' AND data LIKE '%dispatch deleted child%' ORDER BY seq DESC LIMIT 1)`,
          );
          link.connect("watch");
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice' AND data LIKE '%target_deleted%'`,
          );
          await waitSettled(state);
          return {
            deletedStatus: deleted.status,
            hubNotices: readRows(
              state.hubDb,
              `SELECT json_extract(data, '$.reason') AS reason,
                      json_extract(data, '$.message') AS message
               FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice'
               ORDER BY seq`,
            ),
            deliveryReason: readRows(
              state.hubDb,
              `SELECT status, failure_reason FROM deliveries WHERE recipient_task_id = '${removableId}'`,
            ),
          };
        },
      },
      {
        name: "s3-r1-to-p-ordinary-send-and-e9",
        action: async (client) => {
          const link = client.forwarder("link");
          const childId = readTaskId(state.ownerDb, "Delivery Child");
          link.disconnect("watch");
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch ordinary reverse",
            });
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events WHERE task_id = '${childId}' AND type = 'prompt_done' AND seq > (SELECT seq FROM events WHERE task_id = '${childId}' AND type = 'assistant_message' AND data LIKE '%Sent ordinary message.%' ORDER BY seq DESC LIMIT 1)`,
          );
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'prompt_done' AND seq > (SELECT seq FROM events WHERE task_id = '${state.parentId}' AND type = 'user_message' AND data LIKE '%dispatch ordinary reverse%' ORDER BY seq DESC LIMIT 1)`,
          );
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM outbox_cursors WHERE remote_role = 'child' AND remote_host = 'owner' AND pushed_pos >= (SELECT MAX(pos) FROM outbox WHERE remote_role = 'child' AND remote_host = 'owner')`,
          );
          link.connect("watch");
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
             WHERE m.source_task_id = '${childId}' AND m.body = 'ordinary hello from child' AND d.status = 'delivered'`,
          );
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'prompt_done' AND seq > (SELECT seq FROM events WHERE task_id = '${state.parentId}' AND type = 'assistant_message' AND data LIKE '%Parent saw report.%' ORDER BY seq DESC LIMIT 1)`,
          );
          await waitSettled(state);
          return {
            ownerOutboundStatus: readRows(
              state.ownerDb,
              `SELECT d.status FROM deliveries d JOIN messages m ON m.id = d.message_id
               WHERE m.source_task_id = '${childId}' AND m.body = 'ordinary hello from child'`,
            ),
            hubReceivedOrdinary: readRows(
              state.hubDb,
              `SELECT COUNT(*) AS count FROM events WHERE task_id = '${state.parentId}' AND type = 'assistant_message' AND data LIKE '%Parent saw ordinary hello.%'`,
            ),
          };
        },
      },
      {
        name: "s5-deleted-parent-report-fails-without-blocking-live-parent",
        action: async (client) => {
          const link = client.forwarder("link");
          const p2ChildId = readTaskId(state.ownerDb, "Parent Two Child");
          // Hold owner -> hub feed while R2 queues a report, let R2 finish so
          // hub's synchronous delete succeeds, then resume feed to observe the
          // queued report failing with target_deleted without blocking P1.
          link.disconnect("watch");
          await client
            .instance("owner")
            .rest("POST", `/api/v1/tasks/${p2ChildId}/prompt`, {
              text: "report to deleted parent",
            });
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events WHERE task_id = '${p2ChildId}' AND type = 'prompt_done'`,
          );
          const deletedParent = await client
            .instance("hub")
            .rest("DELETE", `/api/v1/tasks/${state.parentTwoId}`);
          link.connect("watch");
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM deliveries WHERE recipient_task_id = '${state.parentTwoId}' AND status = 'failed' AND failure_reason = 'target_deleted'`,
          );
          await waitSettled(state);
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch live report",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'collaboration_prompt' AND data LIKE '%Live parent still receives reports.%'`,
          );
          await waitSettled(state);
          return {
            deletedParentStatus: deletedParent.status,
            deletedParentStillGone: readRows(
              state.hubDb,
              `SELECT COUNT(*) AS count FROM tasks WHERE id = '${state.parentTwoId}'`,
            ),
            deletedChildStillGone: readRows(
              state.ownerDb,
              `SELECT COUNT(*) AS count FROM tasks WHERE id = '${p2ChildId}'`,
            ),
            failedDeletedParentDelivery: readRows(
              state.hubDb,
              `SELECT status, failure_reason FROM deliveries WHERE recipient_task_id = '${state.parentTwoId}'`,
            ),
          };
        },
      },
      {
        name: "s6-owner-no-update-and-hard-delete-notices-reach-hub-p",
        action: async (client) => {
          const noUpdatePrompt = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch no update",
            });
          if (noUpdatePrompt.status !== 202) {
            throw new Error(
              `dispatch no update failed: ${JSON.stringify(noUpdatePrompt)}`,
            );
          }
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'prompt_done' AND seq > (SELECT seq FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice' AND json_extract(data, '$.reason') = 'no_update' ORDER BY seq DESC LIMIT 1)`,
          );
          await waitSettled(state);

          // Now arm the account again and hard-delete Delivery Child on owner -> target_removed with real title.
          const childId = readTaskId(state.ownerDb, "Delivery Child");
          const armPrompt = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch arm for delete",
            });
          if (armPrompt.status !== 202) {
            throw new Error(
              `dispatch arm for delete failed: ${JSON.stringify(armPrompt)}`,
            );
          }
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events WHERE task_id = '${childId}' AND type = 'prompt_done' AND seq > (SELECT seq FROM events WHERE task_id = '${childId}' AND type = 'assistant_message' AND data LIKE '%Account armed and idle.%' ORDER BY seq DESC LIMIT 1)`,
          );
          await client
            .instance("owner")
            .rest("DELETE", `/api/v1/tasks/${childId}`);
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice' AND data LIKE '%left this edge%'`,
          );
          await waitSettled(state);
          return {
            hubNotices: readRows(
              state.hubDb,
              `SELECT json_extract(data, '$.reason') AS reason,
                      json_extract(data, '$.message') AS message
               FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice'
               ORDER BY seq`,
            ),
          };
        },
      },
    ];
  },
});
