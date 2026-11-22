import { scenario, type JsonObject } from "../types.ts";

type State = {
  rootId: string;
  fallbackChildId: string;
  waitingChildId: string | null;
  wakeTargetId: string | null;
};

export default scenario<State>({
  mock: {
    prompts: [
      {
        match: "finish without account",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_update",
                arguments: {
                  status: "done",
                  body: "No account completion.",
                },
              },
            ],
          },
          { type: "reply", text: "Fallback update sent." },
        ],
      },
      {
        match: "Task status: done\nNo account completion.",
        actions: [{ type: "reply", text: "Parent received fallback done." }],
      },
      {
        match: "delegate blocked task",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: { title: "Blocked child", cwd: "." },
              },
              {
                tool: "task_send",
                arguments: {
                  target: "$lastCreatedTaskId",
                  body: "report blocked",
                },
              },
            ],
          },
          { type: "reply", text: "Blocked task delegated." },
        ],
      },
      {
        match: "report blocked",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_update",
                arguments: {
                  status: "blocked",
                  body: "Need parent input.",
                },
              },
            ],
          },
          { type: "reply", text: "Blocked result sent." },
        ],
      },
      {
        match: "Task status: blocked\nNeed parent input.",
        actions: [{ type: "reply", text: "Parent received blocked." }],
      },
      {
        match: "delegate waiting task",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: { title: "Waiting child", cwd: "." },
              },
              {
                tool: "task_send",
                arguments: {
                  target: "$lastCreatedTaskId",
                  body: "build wake target",
                },
              },
            ],
          },
          { type: "reply", text: "Waiting task delegated." },
        ],
      },
      {
        match: "build wake target",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_create",
                arguments: { title: "Wake target", cwd: "." },
              },
              {
                tool: "task_update",
                arguments: {
                  status: "waiting",
                  body: "Waiting before dispatch.",
                },
              },
            ],
          },
          { type: "reply", text: "Wake target created." },
        ],
      },
      {
        match: "park wake target",
        actions: [{ type: "wait", label: "busy-wake-target" }],
      },
      {
        match: "queue for busy child",
        actions: [
          {
            type: "mcp",
            calls: [
              {
                tool: "task_send",
                arguments: {
                  target: "$task:Wake target",
                  body: "wake later",
                },
              },
              {
                tool: "task_update",
                arguments: {
                  status: "waiting",
                  body: "Only wake source is queued child dispatch.",
                },
              },
            ],
          },
          { type: "reply", text: "Waiting with queued child dispatch." },
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
    const child = await context.rest("POST", "/api/v1/tasks", {
      parentId: rootBody.id,
      title: "Fallback child",
    });
    const childBody = child.body as JsonObject;
    if (typeof childBody.id !== "string") {
      throw new Error(`fallback child failed: ${JSON.stringify(child)}`);
    }
    return {
      rootId: rootBody.id,
      fallbackChildId: childBody.id,
      waitingChildId: null,
      wakeTargetId: null,
    };
  },
  steps(_client, state) {
    return [
      {
        name: "done-without-account-falls-back-to-parent",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.fallbackChildId}/prompt`, {
            text: "finish without account",
          }),
      },
      {
        name: "blocked-settles-account",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.rootId}/prompt`, {
            text: "delegate blocked task",
          }),
      },
      {
        name: "create-waiting-subtree",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.rootId}/prompt`, {
            text: "delegate waiting task",
          }),
      },
      {
        name: "discover-waiting-subtree",
        async action(client) {
          const listed = await client.rest("GET", "/api/v1/tasks");
          const tasks = listed.body as JsonObject[];
          const waiting = tasks.find((task) => task.title === "Waiting child");
          const wake = tasks.find((task) => task.title === "Wake target");
          if (typeof waiting?.id !== "string" || typeof wake?.id !== "string") {
            throw new Error(
              `waiting tree not found: ${JSON.stringify(listed)}`,
            );
          }
          state.waitingChildId = waiting.id;
          state.wakeTargetId = wake.id;
          return listed;
        },
      },
      {
        name: "make-wake-target-busy",
        action: (client) =>
          client.rest(
            "POST",
            `/api/v1/tasks/${state.wakeTargetId ?? ""}/prompt`,
            { text: "park wake target" },
          ),
      },
      {
        name: "waiting-with-queued-child-dispatch",
        action: (client) =>
          client.rest(
            "POST",
            `/api/v1/tasks/${state.waitingChildId ?? ""}/prompt`,
            { text: "queue for busy child" },
          ),
      },
    ];
  },
});
