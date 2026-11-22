import { scenario, type JsonObject } from "../types.ts";

type State = {
  taskId: string;
  childId: string | null;
};

export default scenario<State>({
  mock: {
    prompts: [
      {
        match: "start child",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: { title: "Cancelable child", cwd: "." },
              },
              {
                tool: "task_send",
                arguments: {
                  target: "$lastCreatedTaskId",
                  body: "park until cancelled",
                },
              },
            ],
          },
          { type: "reply", text: "Child started." },
        ],
      },
      {
        match: "park until cancelled",
        actions: [{ type: "wait", label: "cancel" }],
      },
      {
        match: "cancel child",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_cancel",
                arguments: {
                  target: "$lastCreatedTaskId",
                  reason: "No longer needed",
                },
              },
              {
                tool: "task_query",
                arguments: { task_id: "$lastCreatedTaskId", range: [-20, -1] },
              },
            ],
          },
          { type: "reply", text: "Child cancelled." },
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
    return { taskId: body.id, childId: null };
  },
  steps(_client, state) {
    return [
      {
        name: "create-and-dispatch-child",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId}/prompt`, {
            text: "start child",
          }),
      },
      {
        name: "cancel-child-and-read-history",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId}/prompt`, {
            text: "cancel child",
          }),
      },
    ];
  },
});
