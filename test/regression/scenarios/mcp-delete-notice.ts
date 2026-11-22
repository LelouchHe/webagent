import { scenario, type JsonObject } from "../types.ts";

type State = { rootId: string; childId: string | null };

export default scenario<State>({
  mock: {
    prompts: [
      {
        match: "delegate removable target",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: { title: "Removable child", cwd: "." },
              },
              {
                tool: "task_send",
                arguments: {
                  target: "$lastCreatedTaskId",
                  body: "park before deletion",
                },
              },
            ],
          },
          { type: "reply", text: "Removable target started." },
        ],
      },
      {
        match: "park before deletion",
        actions: [{ type: "wait", label: "delete-target" }],
      },
      {
        match: "The target left this edge (deleted or archived)",
        actions: [{ type: "reply", text: "Target removal observed." }],
      },
    ],
  },
  async setup(context) {
    const response = await context.rest("POST", "/api/v1/tasks/bootstrap");
    const body = response.body as JsonObject;
    if (typeof body.id !== "string") {
      throw new Error(`bootstrap failed: ${JSON.stringify(response)}`);
    }
    return { rootId: body.id, childId: null };
  },
  steps(_client, state) {
    return [
      {
        name: "deliver-to-target",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.rootId}/prompt`, {
            text: "delegate removable target",
          }),
      },
      {
        name: "discover-removable-target",
        async action(client) {
          const listed = await client.rest("GET", "/api/v1/tasks");
          const tasks = listed.body as JsonObject[];
          const child = tasks.find((task) => task.title === "Removable child");
          if (typeof child?.id !== "string") {
            throw new Error(
              `removable child not found: ${JSON.stringify(listed)}`,
            );
          }
          state.childId = child.id;
          return listed;
        },
      },
      {
        name: "cancel-target-before-delete",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId ?? ""}/cancel`, {
            reason: "Prepare target removal",
          }),
      },
      {
        name: "delete-target-with-open-account",
        action: (client) =>
          client.rest("DELETE", `/api/v1/tasks/${state.childId ?? ""}`),
      },
    ];
  },
});
