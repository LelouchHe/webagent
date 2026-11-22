import { scenario, type JsonObject } from "../types.ts";

export default scenario<{ taskId: string }>({
  mock: {
    onNew: { calls: [{ tool: "task_list" }] },
    prompts: [
      {
        match: "inspect family",
        actions: [
          {
            type: "mcp",
            calls: [
              { tool: "task_list" },
              { tool: "task_query", arguments: { range: [-10, -1] } },
              { tool: "task_read", arguments: { seqs: [1] } },
            ],
          },
          { type: "reply", text: "Family inspected." },
        ],
      },
    ],
  },
  async setup(context) {
    const response = await context.rest("POST", "/api/v1/tasks/bootstrap");
    const body = response.body as JsonObject;
    if (response.status !== 200 || typeof body.id !== "string") {
      throw new Error(`bootstrap failed: ${JSON.stringify(response)}`);
    }
    return { taskId: String(body.id) };
  },
  steps(_client, state) {
    return [
      {
        name: "list-query-read",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId}/prompt`, {
            text: "inspect family",
          }),
      },
      {
        name: "read-transcript",
        action: (client) =>
          client.rest("GET", `/api/v1/tasks/${state.taskId}/events`),
      },
    ];
  },
});
