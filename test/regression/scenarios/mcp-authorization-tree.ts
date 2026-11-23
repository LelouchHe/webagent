import { scenario, type JsonObject } from "../types.ts";

type State = {
  rootId: string;
  childId: string | null;
};

export default scenario<State>({
  mock: {
    prompts: [
      {
        match: "create authorization siblings",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: { title: "Authorization child", cwd: "." },
              },
              {
                tool: "task_create",
                arguments: { title: "Authorization sibling", cwd: "." },
              },
            ],
          },
          { type: "reply", text: "Authorization siblings created." },
        ],
      },
      {
        match: "read and message parent",
        actions: [
          {
            type: "mcp",
            calls: [
              { tool: "task_list" },
              {
                tool: "task_send",
                arguments: { target: "$parentTaskId", body: "hello parent" },
              },
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
          { type: "reply", text: "Parent read and messaged." },
        ],
      },
      {
        match: "hello parent",
        actions: [{ type: "reply", text: "Parent received the message." }],
      },
      {
        match: "reject self and sibling targets",
        actions: [
          {
            type: "mcp",
            calls: [
              { tool: "task_list" },
              {
                tool: "task_send",
                arguments: { target: "$currentTaskId", body: "self" },
              },
              {
                tool: "task_send",
                arguments: {
                  target: "$task:Authorization sibling",
                  body: "sibling",
                },
              },
              {
                tool: "task_query",
                arguments: { task_id: "$task:Authorization sibling" },
              },
              {
                tool: "task_read",
                arguments: {
                  task_id: "$task:Authorization sibling",
                  seqs: [1],
                },
              },
              {
                tool: "task_cancel",
                arguments: { target: "$parentTaskId", reason: "parent" },
              },
              {
                tool: "task_cancel",
                arguments: { target: "$currentTaskId", reason: "self" },
              },
              {
                tool: "task_cancel",
                arguments: {
                  target: "$task:Authorization sibling",
                  reason: "sibling",
                },
              },
              {
                tool: "task_send",
                arguments: { target: "missing-task", body: "missing" },
              },
              {
                tool: "task_cancel",
                arguments: { target: "missing-task", reason: "missing" },
              },
            ],
          },
          { type: "reply", text: "Rejected targets exercised." },
        ],
      },
    ],
  },
  async setup(context) {
    const root = await context.rest("POST", "/api/v1/tasks/bootstrap");
    const rootBody = root.body as JsonObject;
    if (typeof rootBody.id !== "string") {
      throw new Error(`bootstrap failed: ${JSON.stringify(root)}`);
    }
    return {
      rootId: rootBody.id,
      childId: null,
    };
  },
  steps(_client, state) {
    return [
      {
        name: "create-sibling-tree",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.rootId}/prompt`, {
            text: "create authorization siblings",
          }),
      },
      {
        name: "discover-created-siblings",
        async action(client) {
          const listed = await client.rest("GET", "/api/v1/tasks");
          const tasks = listed.body as JsonObject[];
          const child = tasks.find(
            (task) => task.title === "Authorization child",
          );
          if (typeof child?.id !== "string") {
            throw new Error(`child not found: ${JSON.stringify(listed)}`);
          }
          state.childId = child.id;
          return listed;
        },
      },
      {
        name: "child-reads-and-messages-parent",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId ?? ""}/prompt`, {
            text: "read and message parent",
          }),
      },
      {
        name: "child-rejects-self-sibling-and-parent-cancel",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId ?? ""}/prompt`, {
            text: "reject self and sibling targets",
          }),
      },
    ];
  },
});
