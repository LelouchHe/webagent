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

  endpoint(taskId: string, fromTaskId?: string): TaskEndpoint | null {
    const task = this.store.getTask(taskId);
    if (task) return { kind: "local", task };
    if (!this.store.hasHostFacts() || fromTaskId === undefined) return null;
    const edge = this.store.findHostEdgeForParent(taskId, fromTaskId);
    if (edge) return { kind: "remote_child", edge };
    const owner = this.store.getTask(fromTaskId);
    const source = this.store.getHostExternalSource(fromTaskId);
    if (owner?.parent_id === null && source?.parent_task_id === taskId) {
      return {
        kind: "external_parent",
        taskId,
        ownerTaskId: owner.id,
        credentialHash: source.credential_hash,
      };
    }
    return null;
  }

  route(
    sourceId: string,
    targetId: string,
  ): {
    relation: CollaborationRelation | null;
    endpoint: TaskEndpoint | null;
  } {
    const source = this.store.getTask(sourceId);
    const target = this.store.getTask(targetId);
    if (!source) return { relation: null, endpoint: null };
    if (target) {
      return {
        relation: collaborationRelation(source, target),
        endpoint: { kind: "local", task: target },
      };
    }
    if (!this.store.hasHostFacts() || sourceId === targetId) {
      return { relation: null, endpoint: null };
    }
    const edge = this.store.findHostEdgeForParent(targetId, sourceId);
    if (edge) {
      return {
        relation: "child",
        endpoint: { kind: "remote_child", edge },
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
      };
    }
    return { relation: null, endpoint: null };
  }

  relation(sourceId: string, targetId: string): CollaborationRelation | null {
    const source = this.store.getTask(sourceId);
    const target = this.store.getTask(targetId);
    if (source && target) return collaborationRelation(source, target);
    if (!source || sourceId === targetId || !this.store.hasHostFacts()) {
      return sourceId === targetId && source ? "self" : null;
    }
    if (this.store.findHostEdgeForParent(targetId, sourceId)) return "child";
    const external = this.store.getHostExternalSource(sourceId);
    if (source.parent_id === null && external?.parent_task_id === targetId) {
      return "parent";
    }
    return null;
  }

  parentOf(taskId: string): string | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    if (task.parent_id !== null) return task.parent_id;
    if (!this.store.hasHostFacts()) return null;
    return this.store.getHostExternalSource(taskId)?.parent_task_id ?? null;
  }

  childrenOf(taskId: string): string[] {
    const local = this.store.listLocalChildren(taskId);
    if (!this.store.hasHostFacts()) return local;
    return local.concat(
      this.store
        .listHostEdgesForParent(taskId)
        .map((edge) => edge.remote_task_id),
    );
  }

  hasChildWakeSource(parentId: string): boolean {
    if (!this.store.hasQueuedDispatchToChild(parentId)) {
      return (
        this.store.hasHostFacts() && this.store.hasOpenHostDispatch(parentId)
      );
    }
    return true;
  }

  describe(
    taskId: string,
    fromTaskId?: string,
  ): {
    title: string;
    where: "local" | "remote_child" | "external_parent";
    hostLabel?: string;
  } | null {
    const endpoint = this.endpoint(taskId, fromTaskId);
    if (!endpoint) return null;
    if (endpoint.kind === "local") {
      return {
        title: endpoint.task.title ?? endpoint.task.id,
        where: "local",
      };
    }
    if (endpoint.kind === "remote_child") {
      return {
        title: endpoint.edge.display_title,
        where: "remote_child",
        hostLabel: endpoint.edge.host_name,
      };
    }
    return { title: endpoint.taskId, where: "external_parent" };
  }
}
