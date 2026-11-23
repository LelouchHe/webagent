import { scenario, type JsonObject } from "../types.ts";

type State = { taskId: string | null };

export default scenario<State>({
  mock: {
    onNew: {
      calls: [{ tool: "task_list" }],
    },
    prompts: [
      {
        match: "exercise denied tools",
        actions: [
          {
            type: "mcp",
            calls: [
              { tool: "task_query", arguments: { task_id: "not-family" } },
              {
                tool: "task_read",
                arguments: { task_id: "not-family", seqs: [1] },
              },
              {
                tool: "task_send",
                arguments: { target: "not-family", body: "denied" },
              },
              {
                tool: "task_cancel",
                arguments: { target: "not-family", reason: "denied" },
              },
            ],
          },
          { type: "reply", text: "Denied operations attempted." },
        ],
      },
      {
        match: "exercise missing capability",
        actions: [
          {
            type: "mcp",
            capability: "missing",
            calls: [{ tool: "task_list" }],
          },
          { type: "reply", text: "Missing capability attempted." },
        ],
      },
      {
        match: "exercise stale capability",
        actions: [
          {
            type: "mcp",
            capability: "first",
            calls: [{ tool: "task_list" }],
          },
          { type: "reply", text: "Stale capability attempted." },
        ],
      },
    ],
  },
  setup() {
    return { taskId: null };
  },
  steps(_client, state) {
    return [
      {
        name: "bootstrap-with-initializing-capability",
        async action(client) {
          const response = await client.rest("POST", "/api/v1/tasks/bootstrap");
          const body = response.body as JsonObject;
          if (typeof body.id !== "string") {
            throw new Error(`bootstrap failed: ${JSON.stringify(response)}`);
          }
          state.taskId = body.id;
          return response;
        },
      },
      {
        name: "denied-family-operations",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId ?? ""}/prompt`, {
            text: "exercise denied tools",
          }),
      },
      {
        name: "missing-rest-token",
        action: (client) =>
          client.rest("GET", "/api/v1/tasks", undefined, "wat_invalid"),
      },
      {
        name: "missing-mcp-capability",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId ?? ""}/prompt`, {
            text: "exercise missing capability",
          }),
      },
      {
        name: "rotate-execution",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId ?? ""}/clear`, {}),
      },
      {
        name: "stale-mcp-capability",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId ?? ""}/prompt`, {
            text: "exercise stale capability",
          }),
      },
    ];
  },
});
