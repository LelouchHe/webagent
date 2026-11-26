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
  // Let post-prompt_done microtasks (e.g. idle drain check) finish before step boundary.
  await new Promise((resolve) => setTimeout(resolve, 100));
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
            match: "queued while post down",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Handled after post reconnect.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Post reconnect done." },
            ],
          },
          {
            match: "drop first 202",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Handled after dropped 202.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Dropped 202 done." },
            ],
          },
          {
            match: "finish offline watch one",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Offline report one.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Offline one done." },
            ],
          },
          {
            match: "finish offline watch two",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Offline report two.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Offline two done." },
            ],
          },
          {
            match: "held first",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "waiting",
                      body: "First held claimed.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Held first done." },
            ],
          },
          {
            match: "second after receipt",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "done",
                      body: "Second after receipt done.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Second after receipt done." },
            ],
          },
        ],
      },
    },
    hub: {
      mock: {
        prompts: [
          {
            match: "create two remote children",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Child One",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                  {
                    tool: "task_create",
                    arguments: {
                      title: "Child Two",
                      agent: "mock",
                      host: "owner",
                    },
                  },
                ],
              },
              { type: "reply", text: "Created two remote children." },
            ],
          },
          {
            match: "send while post down",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Child One",
                      body: "queued while post down",
                    },
                  },
                ],
              },
              { type: "reply", text: "Queued while post down." },
            ],
          },
          {
            match: "send drop 202",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Child One",
                      body: "drop first 202",
                    },
                  },
                ],
              },
              { type: "reply", text: "Sent drop 202." },
            ],
          },
          {
            match: "send two back to back",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Child One",
                      body: "held first",
                    },
                  },
                  {
                    tool: "task_send",
                    arguments: {
                      target: "$task:Child One",
                      body: "second after receipt",
                    },
                  },
                ],
              },
              { type: "reply", text: "Queued pair." },
            ],
          },
          {
            match: "wait with remote child",
            actions: [
              {
                type: "mcp",
                calls: [
                  {
                    tool: "task_update",
                    arguments: {
                      status: "waiting",
                      body: "Waiting for remote child.",
                    },
                  },
                ],
              },
              { type: "reply", text: "Waiting with remote child." },
            ],
          },
          {
            match: "Task status: done",
            actions: [{ type: "reply", text: "Report received." }],
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
    return {
      parentId: body.id,
      ownerDb: join(context.instances.owner.root, "data", "webagent.db"),
      hubDb: join(context.instances.hub.root, "data", "webagent.db"),
    };
  },
  steps(_client, state) {
    return [
      {
        name: "create-two-remote-children",
        action: (client) =>
          client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "create two remote children",
            }),
      },
      {
        name: "post-disconnect-queues-and-recovers-once",
        action: async (client) => {
          const link = client.forwarder("link");
          link.disconnect("post");
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "send while post down",
            });
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events
             WHERE task_id = '${state.parentId}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${state.parentId}'
                            AND data LIKE '%Queued while post down.%')`,
          );
          const whileDown = {
            hubOutbox: await waitForRows(
              state.hubDb,
              `SELECT category FROM outbox
               WHERE remote_role = 'child' AND data_json LIKE '%queued while post down%'`,
            ),
            ownerMessages: readRows(
              state.ownerDb,
              `SELECT COUNT(*) AS count FROM messages WHERE body = 'queued while post down'`,
            ),
          };
          // Ensure the initial push attempt hits the disconnected forwarder (503)
          // before reconnecting so the retry count is deterministic.
          await new Promise((resolve) => setTimeout(resolve, 100));
          link.connect("post");
          await waitForRows(
            state.hubDb,
            `SELECT d.status FROM deliveries d
             JOIN messages m ON m.id = d.message_id
             WHERE m.body = 'queued while post down' AND d.status = 'delivered'`,
          );
          await waitForRows(
            state.ownerDb,
            `SELECT d.status FROM deliveries d
             JOIN messages m ON m.id = d.message_id
             WHERE m.body LIKE '%Handled after post reconnect.%' AND d.status = 'delivered'`,
          );
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events
             WHERE task_id = '${state.parentId}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${state.parentId}'
                            AND data LIKE '%Handled after post reconnect.%')`,
          );
          await waitSettled(state);
          return {
            whileDown,
            ownerCount: readRows(
              state.ownerDb,
              `SELECT COUNT(*) AS count FROM messages WHERE body = 'queued while post down'`,
            ),
          };
        },
      },
      {
        name: "dropped-202-retries-idempotently",
        action: async (client) => {
          const link = client.forwarder("link");
          link.disconnect("watch");
          await waitForHost(client, "hub", "owner", "unreachable");
          link.dropNextResponse("post");
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "send drop 202",
            });
          // Wait until hub's push cursor advances past the retried entry.
          const entry = (await waitForRows(
            state.hubDb,
            `SELECT pos FROM outbox
             WHERE remote_role = 'child' AND data_json LIKE '%drop first 202%'`,
          )) as Array<{ pos: number }>;
          await waitForRows(
            state.hubDb,
            `SELECT pushed_pos FROM outbox_cursors
             WHERE remote_role = 'child' AND remote_host = 'owner'
               AND pushed_pos >= ${entry[0].pos}`,
          );
          const ownerCount = readRows(
            state.ownerDb,
            `SELECT COUNT(*) AS count FROM messages WHERE body = 'drop first 202'`,
          );
          link.connect("watch");
          await waitForHost(client, "hub", "owner", "connected");
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events
             WHERE task_id = '${state.parentId}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${state.parentId}'
                            AND data LIKE '%Handled after dropped 202.%')`,
          );
          await waitSettled(state);
          return { ownerCount };
        },
      },
      {
        name: "watch-disconnect-delivers-two-reports-in-order",
        action: async (client) => {
          const link = client.forwarder("link");
          const childOne = readTaskId(state.ownerDb, "Child One");
          const childTwo = readTaskId(state.ownerDb, "Child Two");
          link.disconnect("watch");
          await waitForHost(client, "hub", "owner", "unreachable");
          // Let owner process the TCP close on the dropped watch socket before
          // publishing offline reports so subscription cleanup is deterministic.
          await new Promise((resolve) => setTimeout(resolve, 100));
          await client
            .instance("owner")
            .rest("POST", `/api/v1/tasks/${childOne}/prompt`, {
              text: "finish offline watch one",
            });
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events
             WHERE task_id = '${childOne}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${childOne}'
                            AND type = 'task_update')`,
          );
          await client
            .instance("owner")
            .rest("POST", `/api/v1/tasks/${childTwo}/prompt`, {
              text: "finish offline watch two",
            });
          await waitForRows(
            state.ownerDb,
            `SELECT 1 FROM events
             WHERE task_id = '${childTwo}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${childTwo}'
                            AND type = 'task_update')`,
          );
          link.connect("watch");
          await waitForHost(client, "hub", "owner", "connected");
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events
             WHERE task_id = '${state.parentId}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${state.parentId}'
                            AND data LIKE '%Offline report two.%')`,
          );
          await waitSettled(state);
          const ordered = readRows(
            state.hubDb,
            `SELECT m.body FROM messages m
             JOIN deliveries d ON d.message_id = m.id
             WHERE d.source_remote_role = 'child'
               AND (m.body LIKE '%Offline report one.%' OR m.body LIKE '%Offline report two.%')
             ORDER BY d.rowid`,
          );
          return { ordered };
        },
      },
      {
        name: "receipt-before-202-unblocks-next-entry",
        action: async (client) => {
          const link = client.forwarder("link");
          const held = link.holdNextResponse("post");
          await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "send two back to back",
            });
          await held;
          // While the first POST response is still held, the receipt for the
          // first entry arrives over watch and unblocks the second entry.
          const secondArrivedBeforeRelease = await waitForRows(
            state.ownerDb,
            `SELECT COUNT(*) AS count FROM messages
             WHERE body = 'second after receipt'`,
          );
          link.release("post");
          await waitForRows(
            state.hubDb,
            `SELECT 1 FROM events
             WHERE task_id = '${state.parentId}' AND type = 'prompt_done'
               AND seq > (SELECT MAX(seq) FROM events
                          WHERE task_id = '${state.parentId}'
                            AND data LIKE '%Second after receipt done.%')`,
          );
          await waitSettled(state);
          return { secondArrivedBeforeRelease };
        },
      },
      {
        name: "e3-waiting-with-remote-child-suppresses-no-wake-note",
        action: async (client) => {
          const link = client.forwarder("link");
          link.disconnect("watch");
          await waitForHost(client, "hub", "owner", "unreachable");
          const response = await client
            .instance("hub")
            .rest("POST", `/api/v1/tasks/${state.parentId}/prompt`, {
              text: "wait with remote child",
            });
          link.connect("watch");
          await waitForHost(client, "hub", "owner", "connected");
          return { status: response.status };
        },
      },
    ];
  },
});
