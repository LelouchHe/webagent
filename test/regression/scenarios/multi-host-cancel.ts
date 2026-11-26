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
  remoteChildId: string;
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
            match: "hold until cancelled",
            actions: [{ type: "wait", label: "remote-work" }],
          },
        ],
      },
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create remote worker",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Cancel Worker",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created remote worker." },
            ],
          },
          {
            match: "dispatch work to worker",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Cancel Worker",
                      body: "hold until cancelled",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dispatched work." },
            ],
          },
          {
            match: "agent cancel worker",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_cancel",
                    arguments: {
                      target: "$task:Cancel Worker",
                      reason: "stop remote work",
                    },
                  },
                ],
              },
              { type: "reply", text: "Cancelled worker." },
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
    const hub = ctx.instance("hub");
    const bootstrapped = await hub.rest("POST", "/api/v1/tasks/bootstrap");
    const rootBody = bootstrapped.body as JsonObject;
    if (typeof rootBody.id !== "string") {
      throw new Error(`bootstrap failed: ${JSON.stringify(bootstrapped)}`);
    }
    const parent = await hub.rest("POST", "/api/v1/tasks", {
      title: "Cancel Parent",
      parentId: rootBody.id,
    });
    const parentBody = parent.body as JsonObject;
    if (typeof parentBody.id !== "string") {
      throw new Error(`parent create failed: ${JSON.stringify(parent)}`);
    }
    const parentId = parentBody.id;
    return {
      parentId,
      remoteChildId: "",
      ownerDb: join(ctx.instances.owner.root, "data", "webagent.db"),
      hubDb: join(ctx.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps: () => [
    {
      name: "create remote worker and start long turn",
      async action(client, state) {
        const hub = client.instance("hub");
        await hub.rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
          text: "create remote worker",
        });
        await waitForRows(
          state.ownerDb,
          `SELECT id FROM tasks WHERE title = 'Cancel Worker'`,
        );
        state.remoteChildId = readTaskId(state.ownerDb, "Cancel Worker");
        await hub.rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
          text: "dispatch work to worker",
        });
        await waitForRows(
          state.ownerDb,
          `SELECT id FROM deliveries WHERE recipient_task_id = '${state.remoteChildId}' AND status = 'delivered'`,
        );
        return { remoteCreated: true };
      },
    },
    {
      name: "user cancels remote worker via hub REST with no cancel records",
      async action(client, state) {
        const hub = client.instance("hub");
        const res = await hub.rest(
          "POST",
          `/api/v1/tasks/${state.remoteChildId}/cancel`,
        );
        const hubCancelRows = readRows(
          state.hubDb,
          `SELECT COUNT(*) AS n FROM events WHERE type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel'`,
        );
        const ownerCancelRows = readRows(
          state.ownerDb,
          `SELECT COUNT(*) AS n FROM events WHERE type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel'`,
        );
        return {
          status: res.status,
          body: res.body,
          hubCancelRows,
          ownerCancelRows,
        };
      },
    },
    {
      name: "agent task_cancel cancels remote worker and writes one record on each side",
      async action(client, state) {
        const hub = client.instance("hub");
        await hub.rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
          text: "agent cancel worker",
        });
        await waitForRows(
          state.hubDb,
          `SELECT seq FROM events WHERE task_id = '${state.parentId}' AND type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel'`,
        );
        const hubRows = readRows(
          state.hubDb,
          `SELECT json_extract(data, '$.role') AS role, json_extract(data, '$.reason') AS reason FROM events WHERE task_id = '${state.parentId}' AND type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel'`,
        );
        const ownerRows = readRows(
          state.ownerDb,
          `SELECT json_extract(data, '$.role') AS role, json_extract(data, '$.reason') AS reason FROM events WHERE task_id = '${state.remoteChildId}' AND type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel'`,
        );
        return { hubRows, ownerRows };
      },
    },
    {
      name: "dropped cancel response yields unknown result without hub source row while owner target row commits",
      async action(client, state) {
        const hub = client.instance("hub");
        client.forwarder("link").dropNextResponse("cancel");
        await hub.rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
          text: "agent cancel worker",
        });
        await waitForRows(
          state.ownerDb,
          `SELECT COUNT(*) AS n FROM events WHERE task_id = '${state.remoteChildId}' AND type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel' HAVING n = 2`,
        );
        const hubCount = readRows(
          state.hubDb,
          `SELECT COUNT(*) AS n FROM events WHERE task_id = '${state.parentId}' AND type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel'`,
        );
        const ownerCount = readRows(
          state.ownerDb,
          `SELECT COUNT(*) AS n FROM events WHERE task_id = '${state.remoteChildId}' AND type = 'system_message' AND json_extract(data, '$.kind') = 'task_cancel'`,
        );
        return { hubCount, ownerCount };
      },
    },
  ],
});
