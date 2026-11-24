import Database from "better-sqlite3";
import { join } from "node:path";
import { scenario, type Json, type JsonObject } from "../types.ts";
import {
  EMPTY_MOCK,
  hubHostConfig,
  provisionHostToken,
  waitForHost,
} from "../multi-host.ts";

interface State {
  parentId: string;
  ownerDb: string;
  hubDb: string;
  wrongPeerToken: string;
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

async function waitForRows(state: State, sql: string): Promise<Json> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const rows = readRows(state.hubDb, sql);
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
                      agent: "mock@owner",
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
            match: "Task Handoff Required",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Interrupted busy turn closed.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Interrupted turn closed." },
            ],
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
    await provisionHostToken(context, { scope: "host" });
    const wrongPeer = await context
      .instance("owner")
      .rest("POST", "/api/v1/tokens", {
        name: "wrong-peer",
        scope: "host",
      });
    const wrongBody = wrongPeer.body as JsonObject;
    if (wrongPeer.status !== 201 || typeof wrongBody.token !== "string") {
      throw new Error(`wrong-peer token failed: ${JSON.stringify(wrongPeer)}`);
    }
    const bootstrapped = await context
      .instance("hub")
      .rest("POST", "/api/v1/tasks/bootstrap");
    const body = bootstrapped.body as JsonObject;
    if (typeof body.id !== "string") {
      throw new Error(`hub bootstrap failed: ${JSON.stringify(bootstrapped)}`);
    }
    return {
      parentId: body.id,
      wrongPeerToken: wrongBody.token,
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
        name: "owner-attaches-remote-task-locally",
        action: (client) =>
          client
            .instance("owner")
            .rest("POST", `/api/v1/tasks/${readRemoteId(state)}/unarchive`),
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
          const ownerStatus = await client
            .instance("owner")
            .rest("GET", `/api/v1/tasks/${readRemoteId(state)}/status`);
          return {
            prompt: { status: prompt.status, body: prompt.body },
            ownerStatus: {
              status: ownerStatus.status,
              body: ownerStatus.body,
            },
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
            state,
            `SELECT d.status, d.idempotency_key
             FROM deliveries d
             WHERE d.idempotency_key LIKE 'remote-report:%'
               AND d.status = 'queued'
             ORDER BY d.idempotency_key`,
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
            `SELECT m.source_task_id, m.direct_target_task_id, d.idempotency_key, d.status
             FROM messages m
             JOIN deliveries d ON d.message_id = m.id
             WHERE d.idempotency_key LIKE 'remote-report:%'
             ORDER BY d.idempotency_key`,
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
          return {
            reports: readRows(
              state.hubDb,
              `SELECT m.source_task_id, m.direct_target_task_id, d.idempotency_key
               FROM messages m
               JOIN deliveries d ON d.message_id = m.id
               WHERE d.idempotency_key LIKE 'remote-report:%'
               ORDER BY d.idempotency_key`,
            ),
            links: readRows(
              state.hubDb,
              `SELECT local_task_id, remote_task_id, remote_role, remote_host
               FROM remote_task_links ORDER BY remote_role, local_task_id`,
            ),
          };
        },
      },
      {
        name: "wrong-peer-cannot-dispatch",
        action: (client) =>
          client.instance("owner").rest(
            "POST",
            `/api/v1/tasks/${state.parentId}/messages`,
            {
              targetTaskId: readRemoteId(state),
              body: "wrong peer dispatch",
            },
            state.wrongPeerToken,
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
          return { restart, connected };
        },
      },
    ];
  },
});
