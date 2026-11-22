import { scenario, type JsonObject } from "../types.ts";

type State = {
  rootId: string;
  childId: string | null;
};

export default scenario<State>({
  mock: {
    prompts: [
      {
        match: "wait for cancel",
        actions: [{ type: "wait", label: "rest-cancel" }],
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
        name: "create-named-child",
        async action(client) {
          const response = await client.rest("POST", "/api/v1/tasks", {
            parentId: state.rootId,
            title: "REST child",
          });
          const body = response.body as JsonObject;
          if (typeof body.id === "string") state.childId = body.id;
          return response;
        },
      },
      {
        name: "prompt-child",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId}/prompt`, {
            text: "wait for cancel",
          }),
      },
      {
        name: "cancel-child",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId}/cancel`, {
            reason: "REST cancellation",
          }),
      },
      {
        name: "list-tasks",
        action: (client) => client.rest("GET", "/api/v1/tasks"),
      },
      {
        name: "archive-child",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId}/archive`, {}),
      },
      {
        name: "list-archived",
        action: (client) => client.rest("GET", "/api/v1/tasks?archived=true"),
      },
      {
        name: "unarchive-child",
        action: (client) =>
          client.rest("POST", `/api/v1/tasks/${state.childId}/unarchive`, {
            parentId: state.rootId,
          }),
      },
    ];
  },
});
