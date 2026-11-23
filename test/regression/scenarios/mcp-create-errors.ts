import { scenario, type JsonObject } from "../types.ts";

export default scenario<{ taskId: string }>({
  mock: {
    prompts: [
      {
        match: "reject invalid creates",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: {
                  title: "Invalid directory",
                  cwd: "/webagent-regression-no-such-directory",
                },
              },
              {
                tool: "task_create",
                arguments: { title: "Unique child", cwd: "." },
              },
              {
                tool: "task_create",
                arguments: { title: "Unique child", cwd: "." },
              },
            ],
          },
          { type: "reply", text: "Invalid creates attempted." },
        ],
      },
    ],
  },
  async setup(context) {
    const response = await context.rest("POST", "/api/v1/tasks/bootstrap");
    const body = response.body as JsonObject;
    if (typeof body.id !== "string") {
      throw new Error(`bootstrap failed: ${JSON.stringify(response)}`);
    }
    return { taskId: body.id };
  },
  steps(_client, state) {
    return [
      {
        name: "invalid-cwd-and-duplicate-title",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId}/prompt`, {
            text: "reject invalid creates",
          }),
      },
    ];
  },
});
