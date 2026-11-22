import { randomUUID } from "node:crypto";
import type {
  CollaborationDeliveryRow,
  CollaborationMessageRow,
  Store,
  TaskRow,
} from "./store.ts";
import type {
  DeliveryKind,
  DeliveryRequest,
  DeliveryRoute,
  TaskLocator,
} from "./task-locator.ts";

export interface CommittedDelivery {
  messageId: string;
  deliveryId: string;
  sourceTaskId: string;
  targetTaskId: string;
  kind: DeliveryKind;
  localTarget: boolean;
}

export interface EnqueueInput {
  sourceId: string;
  targetId: string;
  kind: DeliveryKind;
  body: string;
  mutate?: (ids: { messageId: string; deliveryId: string }) => void;
  updateStatus?: "done" | "blocked";
  runtimeKind?: string | null;
  reason?: string | null;
  relationHint?: "parent" | "child";
  knownSource?: TaskRow;
}

export class DeliveryQueue {
  private readonly store: Store;
  private readonly locator: TaskLocator;
  private readonly observers: Array<(delivery: CommittedDelivery) => void> = [];

  constructor(store: Store, locator: TaskLocator) {
    this.store = store;
    this.locator = locator;
  }

  onCommitted(observer: (delivery: CommittedDelivery) => void): void {
    this.observers.push(observer);
  }

  enqueue(
    input: EnqueueInput,
    route: DeliveryRoute | null = this.locator.route(
      input.sourceId,
      input.targetId,
      input.relationHint,
      input.knownSource,
    ),
  ): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
    route: DeliveryRoute | null;
  } {
    if (!route && input.kind === "notice") {
      const messageId = randomUUID();
      const deliveryId = randomUUID();
      const createdAt = Date.now();
      const created = this.store.transaction(() => {
        input.mutate?.({ messageId, deliveryId });
        const delegated = this.locator.enqueueOther({
          messageId,
          deliveryId,
          sourceTaskId: input.sourceId,
          targetTaskId: input.targetId,
          kind: input.kind,
          body: input.body,
          createdAt,
          updateStatus: input.updateStatus,
          runtimeKind: input.runtimeKind,
          reason: input.reason,
        });
        if (delegated) return delegated;
        if (!this.store.getTask(input.targetId)) {
          throw new Error("task_not_found");
        }
        return this.store.enqueueDeliveryRows({
          messageId,
          deliveryId,
          sourceTaskId: input.sourceId,
          directTargetTaskId: input.targetId,
          sourceActor: "system",
          body: input.body,
          createdAt,
          projections: [{ taskId: input.targetId, role: "target" }],
        });
      });
      this.publishCommitted(input, created, true);
      return { ...created, route: null };
    }
    if (!route) throw new Error("task_not_found");
    const expectedKind = route.relation === "child" ? "dispatch" : "message";
    if (
      (input.kind === "dispatch" || input.kind === "message") &&
      input.kind !== expectedKind
    ) {
      throw new Error("message_kind_not_allowed");
    }
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const createdAt = Date.now();
    const created = this.store.transaction(() => {
      input.mutate?.({ messageId, deliveryId });
      const request: DeliveryRequest = {
        messageId,
        deliveryId,
        sourceTaskId: input.sourceId,
        targetTaskId: input.targetId,
        kind: input.kind,
        body: input.body,
        createdAt,
        updateStatus: input.updateStatus,
        runtimeKind: input.runtimeKind,
        reason: input.reason,
      };
      if (route.localTask) {
        return input.kind === "notice"
          ? this.store.enqueueDeliveryRows({
              messageId,
              deliveryId,
              sourceTaskId: input.sourceId,
              directTargetTaskId: input.targetId,
              sourceActor: "system",
              body: input.body,
              createdAt,
              projections: [{ taskId: input.targetId, role: "target" }],
            })
          : this.store.createCollaborationMessageInStoreTransaction(
              {
                id: messageId,
                deliveryId,
                sourceTaskId: input.sourceId,
                directTargetTaskId: input.targetId,
                sourceActor: "agent",
                body: input.body,
                createdAt,
              },
              {
                source: route.source,
                target: route.localTask,
              },
            );
      }
      const delegated = this.locator.enqueueOther(request);
      if (!delegated) throw new Error("task_not_found");
      return delegated;
    });
    this.publishCommitted(input, created, route.localTask !== null);
    return { ...created, route };
  }

  private publishCommitted(
    input: EnqueueInput,
    created: {
      message: CollaborationMessageRow;
      delivery: CollaborationDeliveryRow;
    },
    localTarget: boolean,
  ): void {
    const committed: CommittedDelivery = {
      messageId: created.message.id,
      deliveryId: created.delivery.id,
      sourceTaskId: input.sourceId,
      targetTaskId: input.targetId,
      kind: input.kind,
      localTarget,
    };
    for (const observer of this.observers) observer(committed);
  }
}
