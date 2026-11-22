import type { HostEdge, Store, TaskRow } from "./store.ts";
import {
  collaborationRelation,
  type CollaborationRelation,
} from "./task-collaboration.ts";

export type TaskEndpoint =
  | { kind: "local"; task: TaskRow }
  | { kind: "remote_child"; edge: HostEdge }
  | {
      kind: "external_parent";
      taskId: string;
      ownerTaskId: string;
      credentialHash: string;
    };

export class TaskLocator {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  route(
    sourceId: string,
    targetId: string,
  ): {
    relation: CollaborationRelation | null;
    endpoint: TaskEndpoint | null;
    source: TaskRow | null;
  } {
    const source = this.store.getTask(sourceId);
    const target = this.store.getTask(targetId);
    if (!source) return { relation: null, endpoint: null, source: null };
    if (target) {
      return {
        relation: collaborationRelation(source, target),
        endpoint: { kind: "local", task: target },
        source,
      };
    }
    if (!this.store.hasHostFacts() || sourceId === targetId) {
      return { relation: null, endpoint: null, source };
    }
    const edge = this.store.findHostEdgeForParent(targetId, sourceId);
    if (edge) {
      return {
        relation: "child",
        endpoint: { kind: "remote_child", edge },
        source,
      };
    }
    const external = this.store.getHostExternalSource(sourceId);
    if (source.parent_id === null && external?.parent_task_id === targetId) {
      return {
        relation: "parent",
        endpoint: {
          kind: "external_parent",
          taskId: targetId,
          ownerTaskId: sourceId,
          credentialHash: external.credential_hash,
        },
        source,
      };
    }
    return { relation: null, endpoint: null, source };
  }

  parentOf(taskId: string): string | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    if (task.parent_id !== null) return task.parent_id;
    if (!this.store.hasHostFacts()) return null;
    return this.store.getHostExternalSource(taskId)?.parent_task_id ?? null;
  }

  hasChildWakeSource(parentId: string): boolean {
    if (!this.store.hasQueuedDispatchToChild(parentId)) {
      return (
        this.store.hasHostFacts() && this.store.hasOpenHostDispatch(parentId)
      );
    }
    return true;
  }
}
