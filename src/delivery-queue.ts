import type {
  CollaborationDeliveryRow,
  CollaborationMessageRow,
  Store,
  TaskRow,
} from "./store.ts";
import type { TaskLocator } from "./task-locator.ts";
import type { TaskEndpoint } from "./task-locator.ts";

export interface EnqueueHooks {
  drainLocal: (taskId: string) => void;
  kickEdge: (edgeId: string) => void;
  notifyExternal: (credentialHash: string) => void;
}

export class DeliveryQueue {
  private readonly store: Store;
  private readonly locator: TaskLocator;
  private readonly hooks: EnqueueHooks;

  constructor(store: Store, locator: TaskLocator, hooks: EnqueueHooks) {
    this.store = store;
    this.locator = locator;
    this.hooks = hooks;
  }

  enqueue(
    input: {
      sourceId: string;
      targetId: string;
      kind: "dispatch" | "message";
      body: string;
    },
    routeInput?: ReturnType<TaskLocator["route"]>,
  ): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
    relation: "parent" | "child";
    endpoint: TaskEndpoint;
    source: TaskRow;
  } {
    const route =
      routeInput ?? this.locator.route(input.sourceId, input.targetId);
    const endpoint = route.endpoint;
    if (!endpoint) throw new Error("task_not_found");
    if (!route.source) throw new Error("task_not_found");
    if (route.relation !== "parent" && route.relation !== "child") {
      throw new Error("target_not_allowed");
    }
    const expectedKind = route.relation === "child" ? "dispatch" : "message";
    if (input.kind !== expectedKind) {
      throw new Error("message_kind_not_allowed");
    }
    let created: {
      message: CollaborationMessageRow;
      delivery: CollaborationDeliveryRow;
    };
    if (endpoint.kind === "local") {
      created = this.store.createCollaborationMessage({
        id: randomUUID(),
        deliveryId: randomUUID(),
        sourceTaskId: input.sourceId,
        directTargetTaskId: endpoint.task.id,
        sourceActor: "agent",
        body: input.body,
      });
      this.hooks.drainLocal(endpoint.task.id);
    } else if (endpoint.kind === "remote_child") {
      created = this.store.createRemoteDispatch({
        parentTaskId: input.sourceId,
        edge: endpoint.edge,
        body: input.body,
      });
      this.hooks.kickEdge(endpoint.edge.id);
    } else {
      const source = this.store.getHostExternalSource(input.sourceId);
      if (source?.parent_task_id !== input.targetId) {
        throw new Error("target_not_allowed");
      }
      created = this.store.createHostAgentMessage({
        sourceTaskId: input.sourceId,
        source,
        body: input.body,
      });
      this.hooks.notifyExternal(source.credential_hash);
    }
    return {
      ...created,
      relation: route.relation,
      endpoint,
      source: route.source,
    };
  }
}
import { randomUUID } from "node:crypto";
