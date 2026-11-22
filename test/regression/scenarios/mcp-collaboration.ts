import { scenario, type JsonObject } from "../types.ts";

type State = { taskId: string; childId: string | null };

export default scenario<State>({
  mock: {
    prompts: [
      {
        match: "delegate review",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: { title: "Regression review", cwd: "." },
              },
              {
                tool: "task_send",
                arguments: {
                  target: "$lastCreatedTaskId",
                  body: "park regression review",
                },
              },
            ],
          },
          { type: "reply", text: "Review delegated." },
        ],
      },
      {
        match: "park regression review",
        actions: [{ type: "wait", label: "review-update" }],
      },
      {
        match: "complete regression review",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_update",
                arguments: { status: "done", body: "Review complete." },
              },
            ],
          },
          { type: "reply", text: "Review finished." },
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
        name: "delegate-send-update",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.taskId}/prompt`, {
            text: "delegate review",
          }),
      },
      {
        name: "cancel-child-wait",
        async action(client) {
          const listed = await client.rest("GET", "/api/v1/tasks");
          const tasks = listed.body as JsonObject[];
          const child = tasks.find(
            (task) => task.title === "Regression review",
          );
          if (typeof child?.id !== "string") {
            throw new Error(`child not found: ${JSON.stringify(listed)}`);
          }
          state.childId = child.id;
          const cancelled = await client.rest(
            "POST",
            `/api/v1/tasks/${state.childId}/cancel`,
            { reason: "Finish through typed update" },
          );
          return [listed, cancelled];
        },
      },
      {
        name: "finish-child-update",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId}/prompt`, {
            text: "complete regression review",
          }),
      },
    ];
  },
});
