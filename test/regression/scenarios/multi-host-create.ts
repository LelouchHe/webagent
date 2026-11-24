import Database from "better-sqlite3";
import { join } from "node:path";
import { scenario, type Json, type JsonObject } from "../types.ts";
import {
  EMPTY_MOCK,
  hubHostConfig,
  provisionHostToken,
  readHostToken,
  type ProvisionedHostToken,
} from "../multi-host.ts";

interface State {
  provisioned: ProvisionedHostToken;
  hubParentId: string;
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

export default scenario<State>({
  mock: EMPTY_MOCK,
  instances: {
    owner: {
      mock: EMPTY_MOCK,
      extraConfig: () => ["[agents.owner-only]", 'cmd = "false"'],
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create remote mcp",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "MCP remote child",
                      agent: "owner-only@owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Remote MCP child created." },
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
      provisioned,
      hubParentId: body.id,
      ownerDb: join(context.instances.owner.root, "data", "webagent.db"),
      hubDb: join(context.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps(_client, state) {
    return [
      {
        name: "ordinary-token-rejects-external-parent",
        action: (client) =>
          client.instance("owner").rest("POST", "/api/v1/tasks", {
            agentId: "owner-only",
            parentId: "external-only-parent",
            title: "Rejected child",
          }),
      },
      {
        name: "host-token-requires-an-external-parent-and-cannot-relay",
        action: (client) =>
          Promise.all([
            client.instance("owner").rest(
              "POST",
              "/api/v1/tasks",
              {
                agentId: "owner-only",
                title: "Missing parent",
              },
              readHostToken(state.provisioned),
            ),
            client.instance("owner").rest(
              "POST",
              "/api/v1/tasks",
              {
                agentId: "owner-only",
                parentId: "   ",
                title: "Blank parent",
              },
              readHostToken(state.provisioned),
            ),
            client.instance("owner").rest(
              "POST",
              "/api/v1/tasks",
              {
                agentId: "owner-only",
                parentId: 42,
                title: "Non-string parent",
              },
              readHostToken(state.provisioned),
            ),
            client.instance("owner").rest(
              "POST",
              "/api/v1/tasks",
              {
                agentId: "owner-only@owner",
                parentId: "external-parent",
                title: "Attempted relay",
              },
              readHostToken(state.provisioned),
            ),
          ]),
      },
      {
        name: "initiator-rejects-malformed-targets-before-dispatch",
        action: (client) =>
          Promise.all([
            client.instance("hub").rest("POST", "/api/v1/tasks", {
              agentId: "@owner",
              parentId: state.hubParentId,
              title: "Missing agent",
            }),
            client.instance("hub").rest("POST", "/api/v1/tasks", {
              agentId: "owner-only@",
              parentId: state.hubParentId,
              title: "Missing host",
            }),
            client.instance("hub").rest("POST", "/api/v1/tasks", {
              agentId: "owner-only@@owner",
              parentId: state.hubParentId,
              title: "Extra separator",
            }),
          ]),
      },
      {
        name: "rest-creates-remote-task",
        action: (client) =>
          client.instance("hub").rest("POST", "/api/v1/tasks", {
            agentId: "owner-only@owner",
            parentId: state.hubParentId,
            title: "REST remote child",
          }),
      },
      {
        name: "mcp-creates-remote-task",
        action: (client) =>
          client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.hubParentId}/prompt`, {
              text: "create remote mcp",
            }),
      },
      {
        name: "links-survive-restarts",
        action: async (client) => {
          await client.restart("owner");
          await client.restart("hub");
          return {
            ownerTasks: readRows(
              state.ownerDb,
              `SELECT id, parent_id, source FROM tasks ORDER BY created_at, id`,
            ),
            hubTasks: readRows(
              state.hubDb,
              `SELECT id, parent_id, source FROM tasks ORDER BY created_at, id`,
            ),
            ownerLinks: readRows(
              state.ownerDb,
              `SELECT local_task_id, remote_task_id, remote_role, remote_host, peer_token_hash
               FROM remote_task_links ORDER BY local_task_id`,
            ),
            hubLinks: readRows(
              state.hubDb,
              `SELECT local_task_id, remote_task_id, remote_role, remote_host, peer_token_hash
               FROM remote_task_links ORDER BY local_task_id`,
            ),
            ownerBindings: readRows(
              state.ownerDb,
              `SELECT task_id, agent_key, agent_session_id
               FROM agent_sessions ORDER BY created_at, task_id`,
            ),
            ownerAnchors: readRows(
              state.ownerDb,
              `SELECT task_id, type, json_extract(data, '$.kind') AS kind
               FROM events WHERE type = 'system_message'
               ORDER BY task_id, seq`,
            ),
          };
        },
      },
    ];
  },
});
