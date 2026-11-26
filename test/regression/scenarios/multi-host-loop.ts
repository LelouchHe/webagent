import Database from "better-sqlite3";
import { join } from "node:path";
import { scenario, type Json, type JsonObject } from "../types.ts";
import {
  EMPTY_MOCK,
  hubHostConfig,
  provisionHostToken,
  readHostToken,
  waitForHost,
} from "../multi-host.ts";

interface State {
  parentId: string;
  ownerDb: string;
  hubDb: string;
  hostToken: string;
  ownerOrigin: string;
}

function readRows(dbPath: string, sql: string): Json {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as Json;
  } finally {
    db.close();
  }
}

function readRemoteId(state: State): string {
  const rows = readRows(
    state.ownerDb,
    "SELECT id FROM tasks WHERE title = 'Remote loop child'",
  );
  const id = Array.isArray(rows) ? rows[0] : undefined;
  if (
    !id ||
    typeof id !== "object" ||
    typeof (id as JsonObject).id !== "string"
  ) {
    throw new Error(`remote task missing: ${JSON.stringify(rows)}`);
  }
  return (id as JsonObject).id as string;
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

export default scenario<State>({
  mock: EMPTY_MOCK,
  instances: {
    owner: {
      mock: {
        prompts: [
          {
            match: "dispatch remote wait",
            actions: [
              {
                type: "permission",
                title: "Run delegated remote work",
                command: "echo delegated-remote-work",
              },
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "waiting",
                      body: "Waiting for owner restart.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Owner handoff is parked." },
            ],
          },
          {
            match: "finish after owner restart",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Remote work completed after restart.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Completion recorded." },
            ],
          },
          {
            match: "replayed dispatch",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Replay deduplicated.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Replay deduplicated." },
            ],
          },
          {
            match: "unreachable dispatch",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Queued dispatch completed after reconnect.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Queued dispatch received." },
            ],
          },
        ],
      },
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create remote loop",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Remote loop child",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Remote task created." },
            ],
          },
          {
            match: "inspect remote loop",
            actions: [
              {
                type: "mcp",
                calls: [
                  { tool: "task_list" },
                  {
                    tool: "task_query",
                    arguments: { task_id: "$task:Remote loop child" },
                  },
                  {
                    tool: "task_read",
                    arguments: {
                      task_id: "$task:Remote loop child",
                      seqs: [1],
                    },
                  },
                ],
              },
              { type: "reply", text: "Remote history read." },
            ],
          },
          {
            match: "dispatch remote wait",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Remote loop child",
                      body: "dispatch remote wait",
                    },
                  },
                ],
              },
              { type: "reply", text: "Remote dispatch accepted." },
            ],
          },
          {
            match: "send replayed dispatch",
            actions: [
              {
                type: "mcp",
                calls: [
                  { tool: "task_list" },
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Remote loop child",
                      body: "replayed dispatch",
                    },
                  },
                ],
              },
              { type: "reply", text: "Replayed dispatch sent." },
            ],
          },
          {
            match: "hold parent busy",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "waiting",
                      body: "Busy until the remote report arrives.",
                    },
                  },
                ],
              },
              { type: "wait", label: "report arrives" },
            ],
          },
          {
            match: "Task status: done",
            actions: [{ type: "reply", text: "Remote report received." }],
          },
          {
            match: "probe unreachable remote",
            actions: [
              {
                type: "mcp",
                calls: [
                  { tool: "task_list" },
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Remote loop child",
                      body: "unreachable dispatch",
                    },
                  },
                ],
              },
              { type: "reply", text: "Unreachable outcome observed." },
            ],
          },
        ],
      },
      extraConfig: hubHostConfig,
    },
  },
  async setup(context) {
    const provisioned = await provisionHostToken(context, { scope: "host" });
    const bootstrapped = await context
      .instance("hub")
      .rest("POST", "/api/v1/tasks/bootstrap");
    const body = bootstrapped.body as JsonObject;
    if (typeof body.id !== "string") {
      throw new Error(`hub bootstrap failed: ${JSON.stringify(bootstrapped)}`);
    }
    return {
      parentId: body.id,
      hostToken: readHostToken(provisioned),
      ownerOrigin: context.instances.owner.origin,
      ownerDb: join(context.instances.owner.root, "data", "webagent.db"),
      hubDb: join(context.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps(_client, state) {
    return [
      {
        name: "create-remote-child",
        action: (client) =>
          client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "create remote loop",
            }),
      },
      {
        name: "list-query-read-without-owner-acp",
        action: async (client) => {
          const response = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "inspect remote loop",
            });
          return {
            response: { status: response.status, body: response.body },
            ownerBindings: readRows(
              state.ownerDb,
              "SELECT task_id, agent_session_id FROM agent_sessions ORDER BY task_id",
            ),
          };
        },
      },
      {
        name: "dispatch-and-handoff-before-owner-restart",
        action: async (client) => {
          const prompt = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "dispatch remote wait",
            });
          // The prompt returns before the hub turn runs; wait until the owner
          // has handed the dispatch to its Task, so the whole dispatch lands in
          // this step on every run.
          const ownerDelivery = await waitForRows(
            state.ownerDb,
            `SELECT m.source_actor, m.body, d.status
             FROM deliveries d JOIN messages m ON m.id = d.message_id
             WHERE m.body = 'dispatch remote wait' AND d.status = 'delivered'`,
          );
          return {
            prompt: { status: prompt.status, body: prompt.body },
            ownerDelivery,
          };
        },
      },
      {
        name: "hold-parent-busy-before-report",
        action: (client) =>
          client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "hold parent busy",
            }),
      },
      {
        name: "owner-restart-report-uses-external-parent-fallback",
        action: async (client) => {
          const restart = await client.restart("owner", () =>
            waitForHost(client, "hub", "owner", "unreachable"),
          );
          const connected = await waitForHost(
            client,
            "hub",
            "owner",
            "connected",
          );
          const prompt = await client
            .instance("owner")
            .rest("POST", `/api/v1/tasks/${readRemoteId(state)}/prompt`, {
              text: "finish after owner restart",
            });
          const queuedReports = await waitForRows(
            state.hubDb,
            `SELECT d.status, d.source_category
             FROM deliveries d
             WHERE d.source_remote_role = 'child'
               AND d.source_category = 'report'
               AND d.status = 'queued'
             ORDER BY d.queued_at`,
          );
          // Let the owner turn finish and the hub persist its applied cursor
          // covering the report before the hub restarts.
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events
             WHERE task_id = '${readRemoteId(state)}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${readRemoteId(state)}'
                            AND type = 'task_update')`,
          );
          const ownerReportPos = readRows(
            state.ownerDb,
            `SELECT MAX(pos) AS pos FROM outbox
             WHERE remote_role = 'parent' AND category = 'report'`,
          ) as Array<{ pos: number }>;
          await waitForRows(
            state.hubDb,
            `SELECT applied_pos FROM outbox_cursors
             WHERE remote_role = 'child' AND remote_host = 'owner'
               AND applied_pos >= ${ownerReportPos[0].pos}`,
          );
          const hubRestart = await client.restart("hub");
          const reconnected = await waitForHost(
            client,
            "hub",
            "owner",
            "connected",
          );
          const reports = readRows(
            state.hubDb,
            `SELECT m.source_task_id, m.direct_target_task_id, d.source_category, d.status
             FROM messages m
             JOIN deliveries d ON d.message_id = m.id
             WHERE d.source_remote_role = 'child'
               AND d.source_category = 'report'
             ORDER BY d.queued_at`,
          );
          return {
            restart,
            connected,
            prompt: { status: prompt.status, body: prompt.body },
            queuedReports,
            hubRestart,
            reconnected,
            reports,
          };
        },
      },
      {
        name: "hub-restart-does-not-duplicate-report",
        action: async (client) => {
          await client.restart("hub");
          await waitForHost(client, "hub", "owner", "connected");
          // Wait until the persisted applied cursor is still >= the report pos
          // and the parent has processed the report cleanly without duplicates.
          const ownerReportPos = readRows(
            state.ownerDb,
            `SELECT MAX(pos) AS pos FROM outbox
             WHERE remote_role = 'parent' AND category = 'report'`,
          ) as Array<{ pos: number }>;
          await waitForRows(
            state.hubDb,
            `SELECT applied_pos FROM outbox_cursors
             WHERE remote_role = 'child' AND remote_host = 'owner'
               AND applied_pos >= ${ownerReportPos[0].pos}`,
          );
          return {
            reports: readRows(
              state.hubDb,
              `SELECT m.source_task_id, m.direct_target_task_id, d.source_category
               FROM messages m
               JOIN deliveries d ON d.message_id = m.id
               WHERE d.source_remote_role = 'child'
                 AND d.source_category = 'report'
               ORDER BY d.queued_at`,
            ),
            links: readRows(
              state.hubDb,
              `SELECT local_task_id, remote_task_id, remote_role, remote_host
               FROM remote_tasks ORDER BY remote_role, local_task_id`,
            ),
          };
        },
      },
      {
        name: "replayed-dispatch-keeps-owner-message-id",
        action: async (client) => {
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "send replayed dispatch",
            });
          const outboxRows = (await waitForRows(
            state.hubDb,
            `SELECT entry_id FROM outbox
             WHERE remote_role = 'child' AND category = 'message'
               AND data_json LIKE '%replayed dispatch%'`,
          )) as Array<{ entry_id: string }>;
          const entryId = outboxRows[0].entry_id;
          // Wait for the original dispatch + report to land on hub.
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events
             WHERE task_id = '${state.parentId}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${state.parentId}'
                            AND data LIKE '%Replay deduplicated.%')`,
          );
          const replay = (bodyText = "replayed dispatch") =>
            fetch(`${state.ownerOrigin}/api/v1/link/entries`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${state.hostToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                id: entryId,
                category: "message",
                data: {
                  sourceTaskId: state.parentId,
                  targetTaskId: readRemoteId(state),
                  sourceLabel: "root",
                  body: bodyText,
                },
              }),
            }).then(async (response) => ({
              status: response.status,
              body: (await response.json()) as Json,
            }));
          const replayed = await replay();
          const conflict = await replay("different body");
          const messages = readRows(
            state.ownerDb,
            `SELECT id, COUNT(*) AS count FROM messages
             WHERE body = 'replayed dispatch'`,
          );
          return { replayed, conflict, messages };
        },
      },
      {
        name: "wrong-source-cannot-dispatch",
        action: (client) =>
          client.instance("owner").rest(
            "POST",
            "/api/v1/link/entries",
            {
              id: "22222222-2222-4222-8222-222222222222",
              category: "message",
              data: {
                sourceTaskId: "not-the-external-parent",
                targetTaskId: readRemoteId(state),
                sourceLabel: "root",
                body: "wrong source dispatch",
              },
            },
            state.hostToken,
          ),
      },
      {
        name: "unreachable-list-and-send",
        async action(client) {
          const restart = await client.restart("owner", async () => {
            await waitForHost(client, "hub", "owner", "unreachable");
            const prompt = await client
              .instance("hub")
              .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
                text: "probe unreachable remote",
              });
            return prompt.body;
          });
          const connected = await waitForHost(
            client,
            "hub",
            "owner",
            "connected",
          );
          // Wait for the offline-queued dispatch to hand off, complete on owner,
          // and deliver its report back to hub so the final state is settled.
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events
             WHERE task_id = '${state.parentId}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${state.parentId}'
                            AND data LIKE '%Queued dispatch completed after reconnect.%')`,
          );
          return { restart, connected };
        },
      },
    ];
  },
});
