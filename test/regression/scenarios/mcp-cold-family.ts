import { scenario, type JsonObject } from "../types.ts";

type State = { childId: string };

export default scenario<State>({
  mock: {
    prompts: [
      {
        match: "read cold parent",
        actions: [
          {
            type: "mcp",
            calls: [
              { tool: "task_list" },
              {
                tool: "task_query",
                arguments: { task_id: "$parentTaskId", range: [-10, -1] },
              },
              {
                tool: "task_read",
                arguments: { task_id: "$parentTaskId", seqs: [1] },
              },
            ],
          },
          { type: "reply", text: "Cold parent read." },
        ],
      },
    ],
  },
  async setup(context) {
    const config = await context.rest("GET", "/api/v1/config");
    const configBody = config.body as JsonObject;
    if (typeof configBody.rootTaskId !== "string") {
      throw new Error(`config failed: ${JSON.stringify(config)}`);
    }
    const child = await context.rest("POST", "/api/v1/tasks", {
      parentId: configBody.rootTaskId,
      title: "Cold-family child",
    });
    const childBody = child.body as JsonObject;
    if (typeof childBody.id !== "string") {
      throw new Error(`child create failed: ${JSON.stringify(child)}`);
    }
    return { childId: childBody.id };
  },
  steps(_client, state) {
    return [
      {
        name: "list-and-read-unmaterialized-parent",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId}/prompt`, {
            text: "read cold parent",
          }),
      },
    ];
  },
});
