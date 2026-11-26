import Database from "better-sqlite3";
import { join } from "node:path";
import { scenario, type Json, type JsonObject } from "../types.ts";
import {
  EMPTY_MOCK,
  hostTokenPath,
  provisionHostToken,
  waitForHost,
} from "../multi-host.ts";

interface State {
  parentId: string;
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
            match: "learn parent id",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Parent id learned.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Learned parent." },
            ],
          },
          {
            match: "send reverse for hub clear",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$promptSourceTaskId",
                      body: "queued reverse message for hub clear",
                    },
                  },
                ],
              },
              { type: "reply", text: "Reverse message sent." },
            ],
          },
          {
            match: "Runtime message:",
            actions: [{ type: "reply", text: "Owner child saw notice." }],
          },
        ],
      },
      extraConfig: () => ["[agents.broken]", 'cmd = "/usr/bin/false"'],
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create clear child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Clear Child",
                      agent: "broken",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created clear child." },
            ],
          },
          {
            match: "dispatch queued for owner clear",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Clear Child",
                      body: "queued forward message for owner clear",
                    },
                  },
                ],
              },
              { type: "reply", text: "Queued forward message." },
            ],
          },
          {
            match: "dispatch learn parent",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Clear Child",
                      body: "learn parent id",
                    },
                  },
                ],
              },
              { type: "reply", text: "Sent learn parent." },
            ],
          },
          {
            match: "Task status: done",
            actions: [{ type: "reply", text: "Parent saw report." }],
          },
          {
            match: "Runtime message:",
            actions: [{ type: "reply", text: "Hub parent saw notice." }],
          },
        ],
      },
      extraConfig: (instances) => [
        "[agents.broken]",
        'cmd = "/usr/bin/false"',
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
    return {
      parentId: body.id,
      ownerDb: join(context.instances.owner.root, "data", "webagent.db"),
      hubDb: join(context.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps(_client, state) {
    return [
      {
        name: "create-child",
        action: async (client) => {
          const created = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "create clear child",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'prompt_done'`,
          );
          return created;
        },
      },
      {
        name: "s1-p-to-r1-clear-notifies-p-once-and-owner-zero-notices",
        action: async (client) => {
          const childId = readTaskId(state.ownerDb, "Clear Child");
          // Child is bound to unavailable agent "broken", so P->R1 stays queued while R1 is idle.
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch queued for owner clear",
            });
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
             WHERE d.recipient_task_id = '${childId}'
               AND m.body = 'queued forward message for owner clear'
               AND d.status = 'queued'`,
          );
          // Let /usr/bin/false exit before /clear so owner's UUID counter is deterministic.
          await new Promise((resolve) => setTimeout(resolve, 150));
          // Rescue R1 onto "mock" via real /clear -> fails queued inbound row with cleared_before_delivery.
          const cleared = await client
            .instance("owner")
            .rest("POST", `/api/v1/tasks/${childId}/clear`, {
              agentId: "mock",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice' AND data LIKE '%cleared_before_delivery%'`,
          );
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'assistant_message' AND data LIKE '%Hub parent saw notice.%'`,
          );
          await waitSettled(state);
          return {
            clearStatus: cleared.status,
            ownerReceipts: readRows(
              state.ownerDb,
              `SELECT json_extract(data_json, '$.status') AS status,
                      json_extract(data_json, '$.failureReason') AS failureReason
               FROM outbox WHERE remote_role = 'parent' AND category = 'receipt'
               ORDER BY pos`,
            ),
            ownerOutboxNotices: readRows(
              state.ownerDb,
              `SELECT COUNT(*) AS count FROM outbox WHERE remote_role = 'parent' AND category = 'notice'`,
            ),
            ownerChildNotices: readRows(
              state.ownerDb,
              `SELECT COUNT(*) AS count FROM events WHERE task_id = '${childId}' AND type = 'task_outcome_notice'`,
            ),
            hubParentNotices: readRows(
              state.hubDb,
              `SELECT json_extract(data, '$.reason') AS reason,
                      json_extract(data, '$.message') AS message
               FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice'
               ORDER BY seq`,
            ),
          };
        },
      },
      {
        name: "s4-r1-to-p-clear-notifies-r1-once-and-hub-zero-notices",
        action: async (client) => {
          const childId = readTaskId(state.ownerDb, "Clear Child");
          // First send one normal message so R1's mock session records P's task id.
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch learn parent",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events WHERE task_id = '${state.parentId}' AND type = 'assistant_message' AND data LIKE '%Parent saw report.%'`,
          );
          await waitSettled(state);
          // Bind hub P to "broken" across restart so R1->P ordinary message stays queued while P is idle.
          await client.restart("hub", async () => {
            const db = new Database(state.hubDb);
            try {
              db.prepare(
                `UPDATE agent_sessions SET agent_key = 'broken' WHERE task_id = ?`,
              ).run(state.parentId);
            } finally {
              db.close();
            }
            return null;
          });
          await waitForHost(client, "hub", "owner", "connected");
          await client
            .instance("owner")
            .rest("POST", `/api/v1/tasks/${childId}/prompt`, {
              text: "send reverse for hub clear",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
             WHERE d.recipient_task_id = '${state.parentId}'
               AND m.body = 'queued reverse message for hub clear'
               AND d.status = 'queued'`,
          );
          // Let /usr/bin/false exit before /clear so hub's UUID counter is deterministic.
          await new Promise((resolve) => setTimeout(resolve, 150));
          // Rescue hub P onto "mock" via real /clear -> fails queued inbound row with cleared_before_delivery.
          const cleared = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/clear`, {
              agentId: "mock",
            });
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events WHERE task_id = '${childId}' AND type = 'task_outcome_notice' AND data LIKE '%cleared_before_delivery%'`,
          );
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events WHERE task_id = '${childId}' AND type = 'assistant_message' AND data LIKE '%Owner child saw notice.%'`,
          );
          await waitSettled(state);
          return {
            clearStatus: cleared.status,
            hubReceipts: readRows(
              state.hubDb,
              `SELECT json_extract(data_json, '$.status') AS status,
                      json_extract(data_json, '$.failureReason') AS failureReason
               FROM outbox WHERE remote_role = 'child' AND category = 'receipt'
               ORDER BY pos`,
            ),
            hubParentNoticeCount: readRows(
              state.hubDb,
              `SELECT COUNT(*) AS count FROM events WHERE task_id = '${state.parentId}' AND type = 'task_outcome_notice'`,
            ),
            ownerChildNotices: readRows(
              state.ownerDb,
              `SELECT json_extract(data, '$.reason') AS reason,
                      json_extract(data, '$.message') AS message
               FROM events WHERE task_id = '${childId}' AND type = 'task_outcome_notice'
               ORDER BY seq`,
            ),
          };
        },
      },
    ];
  },
});
