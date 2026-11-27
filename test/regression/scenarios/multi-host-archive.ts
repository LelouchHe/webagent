import Database from "better-sqlite3";
import { join } from "node:path";
import { scenario, type Json, type JsonObject } from "../types.ts";
import {
  EMPTY_MOCK,
  hostTokenPath,
  provisionHostToken,
} from "../multi-host.ts";

interface State {
  rootId: string;
  unarchiveParentId: string;
  archiveParentId: string;
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
            match: "note before unarchive",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$promptSourceTaskId",
                      body: "pre-unarchive note",
                    },
                  },
                  {
                    tool: "task_update",
                    arguments: {
                      status: "waiting",
                      body: "waiting before unarchive",
                    },
                  },
                ],
              },
              { type: "reply", text: "Sent pre-unarchive note." },
            ],
          },
          {
            match: "report for archived parent",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "report delivered to archived parent",
                    },
                  },
                ],
              },
              { type: "reply", text: "Reported to archived parent." },
            ],
          },
        ],
      },
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create unarchive child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Unarchive Child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created unarchive child." },
            ],
          },
          {
            match: "arm unarchive child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Unarchive Child",
                      body: "note before unarchive",
                    },
                  },
                ],
              },
              { type: "reply", text: "Armed unarchive child." },
            ],
          },
          {
            match: "send after unarchive",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Unarchive Child",
                      body: "should fail after unarchive",
                    },
                  },
                ],
              },
              { type: "reply", text: "Attempted send after unarchive." },
            ],
          },
          {
            match: "pre-unarchive note",
            actions: [{ type: "reply", text: "Received pre-unarchive note." }],
          },
          {
            match: "left this edge",
            actions: [{ type: "reply", text: "Received target removed." }],
          },
          {
            match: "create archive child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Archive Child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created archive child." },
            ],
          },
          {
            match: "dispatch archive child and hold parent",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Archive Child",
                      body: "report for archived parent",
                    },
                  },
                ],
              },
              { type: "wait", label: "hold-parent-before-archive" },
              { type: "reply", text: "Parent turn ended." },
            ],
          },
          {
            match: "report delivered to archived parent",
            actions: [
              { type: "reply", text: "Archived parent received report." },
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
    const bootstrapped = await ctx
      .instance("hub")
      .rest("POST", "/api/v1/tasks/bootstrap");
    const rootId = (bootstrapped.body as JsonObject).id as string;
    return {
      rootId,
      unarchiveParentId: "",
      archiveParentId: "",
      ownerDb: join(ctx.instances.owner.root, "data", "webagent.db"),
      hubDb: join(ctx.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps: () => [
    {
      name: "s1-owner-unarchive-detaches-external-parent-and-notifies-hub",
      action: async (client, state) => {
        const link = client.forwarder("link");
        const created = await client
          .instance("hub")
          .rest("POST", "/api/v1/tasks", {
            title: "Unarchive Parent",
            parentId: state.rootId,
          });
        state.unarchiveParentId = (created.body as JsonObject).id as string;

        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.unarchiveParentId}/prompt`, {
            text: "create unarchive child",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.unarchiveParentId}' AND type = 'prompt_done'`,
        );
        const childId = readTaskId(state.ownerDb, "Unarchive Child");

        // Hold watch while child queues an ordinary message and stays armed, then unarchive on owner.
        link.disconnect("watch");
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.unarchiveParentId}/prompt`, {
            text: "arm unarchive child",
          });
        await waitForRows(
          state.ownerDb,
          `SELECT 1 FROM events WHERE task_id = '${childId}' AND type = 'prompt_done'`,
        );
        const unarchived = await client
          .instance("owner")
          .rest("POST", `/api/v1/tasks/${childId}/unarchive`);
        link.connect("watch");
        await waitSettled(state);
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.unarchiveParentId}' AND type = 'task_outcome_notice'`,
        );

        // Subsequent send from P to unarchived child is rejected locally on hub.
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.unarchiveParentId}/prompt`, {
            text: "send after unarchive",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.unarchiveParentId}' AND type = 'assistant_message' AND data LIKE '%Attempted send after unarchive.%'`,
        );
        await waitSettled(state);

        // Re-archive on owner is one-way (no external parent restored).
        const reArchived = await client
          .instance("owner")
          .rest("POST", `/api/v1/tasks/${childId}/archive`);
        return {
          unarchiveStatus: unarchived.status,
          reArchiveStatus: reArchived.status,
          ownerExternalParentAfter: readRows(
            state.ownerDb,
            `SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = '${childId}' AND remote_role = 'parent'`,
          ),
          hubLinksAfter: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = '${state.unarchiveParentId}'`,
          ),
          hubPreUnarchiveNoteDelivered: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM messages m JOIN deliveries d ON d.message_id = m.id
             WHERE d.recipient_task_id = '${state.unarchiveParentId}' AND m.body = 'pre-unarchive note' AND d.status = 'delivered'`,
          ),
          hubNotices: readRows(
            state.hubDb,
            `SELECT json_extract(data, '$.reason') AS reason FROM events
             WHERE task_id = '${state.unarchiveParentId}' AND type = 'task_outcome_notice'`,
          ),
        };
      },
    },
    {
      name: "s2-hub-archive-preserves-remote-edge-and-queued-inbound-report",
      action: async (client, state) => {
        const created = await client
          .instance("hub")
          .rest("POST", "/api/v1/tasks", {
            title: "Archive Parent",
            parentId: state.rootId,
          });
        state.archiveParentId = (created.body as JsonObject).id as string;

        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.archiveParentId}/prompt`, {
            text: "create archive child",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.archiveParentId}' AND type = 'prompt_done'`,
        );

        // Dispatch to remote child while keeping hub parent busy so child's
        // report arrives at hub and stays queued until parent's turn ends.
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.archiveParentId}/prompt`, {
            text: "dispatch archive child and hold parent",
          });
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
           WHERE d.recipient_task_id = '${state.archiveParentId}'
             AND m.body LIKE '%report delivered to archived parent%'
             AND d.status = 'queued'`,
        );

        // Archive hub parent while inbound report is accepted and queued.
        const archived = await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.archiveParentId}/archive`);

        // Cancel parent's held turn so queued inbound report drains to archived P.
        await client
          .instance("hub")
          .rest("POST", `/api/v1/tasks/${state.archiveParentId}/cancel`);
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
           WHERE d.recipient_task_id = '${state.archiveParentId}'
             AND m.body LIKE '%report delivered to archived parent%'
             AND d.status = 'delivered'`,
        );
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.archiveParentId}' AND type = 'assistant_message' AND data LIKE '%Archived parent received report.%'`,
        );
        await waitForRows(
          state.hubDb,
          `SELECT 1 FROM events WHERE task_id = '${state.archiveParentId}' AND type = 'prompt_done' AND seq > (SELECT seq FROM events WHERE task_id = '${state.archiveParentId}' AND type = 'assistant_message' AND data LIKE '%Archived parent received report.%' ORDER BY seq DESC LIMIT 1)`,
        );
        await waitSettled(state);
        return {
          archiveStatus: archived.status,
          remoteLinkPreserved: readRows(
            state.hubDb,
            `SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = '${state.archiveParentId}' AND remote_role = 'child'`,
          ),
          inboundReportStatus: readRows(
            state.hubDb,
            `SELECT d.status, d.failure_reason FROM deliveries d JOIN messages m ON m.id = d.message_id
             WHERE d.recipient_task_id = '${state.archiveParentId}'
               AND m.body LIKE '%report delivered to archived parent%'`,
          ),
        };
      },
    },
  ],
});
