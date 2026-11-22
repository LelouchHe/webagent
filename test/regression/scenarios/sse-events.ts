import { scenario, type JsonObject } from "../types.ts";

export default scenario<{ taskId: string }>({
  mock: {
    prompts: [
      {
        match: "emit response",
        actions: [{ type: "reply", text: "SSE response." }],
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
        name: "rename-task",
        action: (client) =>
          client.rest("PUT", `/api/v1/tasks/${state.taskId}/title`, {
            value: "SSE root",
          }),
      },
      {
        name: "prompt-task",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId}/prompt`, {
            text: "emit response",
          }),
      },
    ];
  },
});
