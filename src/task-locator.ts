import type {
  CollaborationDeliveryRow,
  CollaborationMessageRow,
  Store,
  TaskRow,
} from "./store.ts";
import {
  collaborationRelation,
  type CollaborationRelation,
} from "./task-collaboration.ts";

export type DeliveryKind = "dispatch" | "message" | "update" | "notice";

export interface TaskDescription {
  id: string;
  title: string;
  relation: CollaborationRelation;
  local: boolean;
  presentation?: Record<string, string | boolean>;
  task?: TaskRow;
}

export interface DeliveryRequest {
  messageId: string;
  deliveryId: string;
  sourceTaskId: string;
  targetTaskId: string;
  kind: DeliveryKind;
  body: string;
  createdAt: number;
  updateStatus?: "done" | "blocked";
  runtimeKind?: string | null;
  reason?: string | null;
}

export interface LocationProvider {
  relation(sourceId: string, targetId: string): CollaborationRelation | null;
  parentOf(taskId: string): string | null;
  childrenOf(taskId: string): string[];
  describe(taskId: string): TaskDescription | null;
  hasChildWakeSource(parentId: string): boolean;
  enqueueDelivery(request: DeliveryRequest): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  } | null;
}

export interface DeliveryRoute {
  source: TaskRow;
  targetId: string;
  relation: Exclude<CollaborationRelation, "self">;
  localTask: TaskRow | null;
  description: TaskDescription;
}

export class TaskLocator {
  private readonly store: Store;
  private readonly providers: readonly LocationProvider[];

  constructor(store: Store, providers: readonly LocationProvider[] = []) {
    this.store = store;
    this.providers = providers;
  }

  relation(sourceId: string, targetId: string): CollaborationRelation | null {
    const source = this.store.getTask(sourceId);
    const target = this.store.getTask(targetId);
    if (source && target) return collaborationRelation(source, target);
    if (!source) return sourceId === targetId ? "self" : null;
    for (const provider of this.providers) {
      const relation = provider.relation(sourceId, targetId);
      if (relation) return relation;
    }
    return null;
  }

  parentOf(taskId: string, knownTask?: TaskRow): string | null {
    const task = knownTask ?? this.store.getTask(taskId);
    if (!task) return null;
    if (task.parent_id !== null) return task.parent_id;
    for (const provider of this.providers) {
      const parent = provider.parentOf(taskId);
      if (parent) return parent;
    }
    return null;
  }

  childrenOf(taskId: string): string[] {
    const result: string[] = [];
    for (const provider of this.providers) {
      for (const childId of provider.childrenOf(taskId)) {
        if (!result.includes(childId)) result.push(childId);
      }
    }
    return result;
  }

  describe(taskId: string): TaskDescription | null {
    const task = this.store.getTask(taskId);
    if (task) {
      return {
        id: task.id,
        title: task.title ?? task.id,
        relation: "self",
        local: true,
        task,
      };
    }
    for (const provider of this.providers) {
      const description = provider.describe(taskId);
      if (description) return description;
    }
    return null;
  }

  hasChildWakeSource(parentId: string): boolean {
    if (this.store.hasQueuedDispatchToChild(parentId)) return true;
    return this.providers.some((provider) =>
      provider.hasChildWakeSource(parentId),
    );
  }

  route(
    sourceId: string,
    targetId: string,
    relationHint?: "parent" | "child",
    knownSource?: TaskRow,
  ): DeliveryRoute | null {
    const source = knownSource ?? this.store.getTask(sourceId);
    if (!source) return null;
    const localTask = this.store.getTask(targetId);
    const relation =
      relationHint ??
      (localTask
        ? collaborationRelation(source, localTask)
        : this.providers
            .map((provider) => provider.relation(sourceId, targetId))
            .find((value): value is CollaborationRelation => value !== null));
    if (relation !== "parent" && relation !== "child") return null;
    if (localTask) {
      return {
        source,
        targetId,
        relation,
        localTask,
        description: {
          id: localTask.id,
          title: localTask.title ?? localTask.id,
          relation,
          local: true,
          task: localTask,
        },
      };
    }
    const description = this.describe(targetId);
    if (!description || description.local) return null;
    return {
      source,
      targetId,
      relation,
      localTask: null,
      description: { ...description, relation },
    };
  }

  enqueueOther(request: DeliveryRequest): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  } | null {
    for (const provider of this.providers) {
      const created = provider.enqueueDelivery(request);
      if (created) return created;
    }
    return null;
  }
}
