import { randomUUID } from "node:crypto";
import type { ExecutionBinding } from "../execution-authority.ts";
import { formatFieldBlock } from "../shared/field-block.ts";
import type { LinkRelationData } from "../shared/link-envelope.ts";
import type {
  ArchiveSystemMessage,
  ArchiveTaskResult,
  DeletedExternalParent,
  TaskDelete,
  UnarchiveTaskResult,
} from "../store.ts";
import { stringifyLinkData, type StoreInternal } from "./internal.ts";
import type { LinkOutboxStore } from "./link-outbox.ts";
import type { RemoteRelationsStore } from "./remote-relations.ts";

export interface TaskDeleteStoreOptions {
  hasOpenExternalAccount?: (
    taskId: string,
    externalParentTaskId: string,
  ) => boolean;
}

export class TaskLifecycleStore {
  private readonly store: StoreInternal;
  private readonly remoteRelations: RemoteRelationsStore;
  private readonly linkOutbox: LinkOutboxStore;

  constructor(
    store: StoreInternal,
    remoteRelations: RemoteRelationsStore,
    linkOutbox: LinkOutboxStore,
  ) {
    this.store = store;
    this.remoteRelations = remoteRelations;
    this.linkOutbox = linkOutbox;
  }

  /**
   * Detach a task (and with it its whole subtree) from the tree by clearing
   * `parent_id`. Archive is one-way: nothing is stored, and “archived” is the
   * structure `parent_id IS NULL` on a live non-Root task.
   *
   * The only record written is one `system_message` on the detached task,
   * naming the parent it came from. Children stay attached to it, so they need
   * no rows of their own.
   */
  archiveTask(id: string): ArchiveTaskResult | undefined {
    const task = this.store.getTask(id);
    if (!task) return undefined;
    if (this.store.isRootTaskId(id)) {
      throw new Error("Root task cannot be archived");
    }
    if (task.parent_id === null) {
      return {
        status: "already_archived",
        taskId: id,
        parentId: null,
        parentPath: null,
        message: null,
      };
    }
    const parentId = task.parent_id;
    // Everything this operation persists — detach, transcript fact, and the
    // queued cross-tree delivery marks — commits or rolls back together. The
    // caller drops the in-memory obligation edge only after this returns.
    const archived = this.store.writeOutbox(() => {
      const parentPath = this.store.getTaskPath(parentId) ?? parentId;
      this.store.db
        .prepare(
          "UPDATE tasks SET parent_id = NULL WHERE id = ? AND parent_id = ?",
        )
        .run(id, parentId);
      const message: ArchiveSystemMessage = {
        kind: "task_archive",
        title: "Task archived",
        body: formatFieldBlock([
          { label: "original parent", value: `${parentPath} (${parentId})` },
        ]),
      };
      this.store.saveEvent(
        id,
        "system_message",
        {
          ...message,
          originalParentId: parentId,
          originalParentPath: parentPath,
        },
        { from_ref: "system" },
      );
      const failedDeliveryIds =
        this.markQueuedDeliveriesAcrossSubtreeBoundary(id);
      return {
        result: {
          status: "archived" as const,
          taskId: id,
          parentId,
          parentPath,
          message,
        },
        failedDeliveryIds,
      };
    });
    const { result, failedDeliveryIds } = archived;
    this.store.broadcastDeliveryStatus(failedDeliveryIds);
    return result;
  }

  /**
   * The parent an unarchive should attach to: the recorded original while it is
   * live in the active tree, otherwise the current Root. Null means the
   * original exists inside an archived tree (restore that tree first).
   */
  private resolveUnarchiveTarget(originalParentId: string | null): {
    parentId: string;
    fellBackToRoot: boolean;
    originalMissing: boolean;
  } | null {
    const rootTaskId = this.store.getRootTaskId();
    const root = this.store.getTask(rootTaskId);
    if (!root) return null;
    if (originalParentId === null) {
      return {
        parentId: root.id,
        fellBackToRoot: true,
        originalMissing: false,
      };
    }
    const parent = this.store.getTaskIncludingDeleted(originalParentId);
    if (parent?.deleted_at !== null) {
      return { parentId: root.id, fellBackToRoot: true, originalMissing: true };
    }
    if (this.store.getTaskLineage(originalParentId)?.[0] !== rootTaskId) {
      return null;
    }
    return {
      parentId: originalParentId,
      fellBackToRoot: false,
      originalMissing: false,
    };
  }

  /**
   * Re-attach an archived tree top under the parent recorded by its latest
   * `task_archive` message. Only a live parentless non-Root task qualifies.
   * The update and the transcript fact are one transaction; nothing about the
   * cut obligation/delivery edges is restored.
   */
  unarchiveTask(
    id: string,
    options?: TaskDeleteStoreOptions,
  ): UnarchiveTaskResult & {
    externalParent?: { remoteHost: string; remoteTaskId: string };
  } {
    const out = this.store.writeOutbox(() => {
      const task = this.store.getTask(id);
      if (!task) {
        return {
          result: { status: "not_found" as const },
          failedDeliveryIds: [] as string[],
        };
      }
      if (this.store.isRootTaskId(id) || task.parent_id !== null) {
        return {
          result: { status: "not_archived" as const },
          failedDeliveryIds: [] as string[],
        };
      }

      const archivedRows = this.store.db
        .prepare(
          `SELECT data FROM events
           WHERE task_id = ? AND type = 'system_message'
           ORDER BY seq DESC`,
        )
        .all(id) as Array<{ data: string }>;
      let originalParentId: string | null = null;
      for (const row of archivedRows) {
        try {
          const data = JSON.parse(row.data) as {
            kind?: unknown;
            originalParentId?: unknown;
          };
          if (
            data.kind === "task_archive" &&
            typeof data.originalParentId === "string"
          ) {
            originalParentId = data.originalParentId;
            break;
          }
        } catch {
          // Ignore malformed rows; the latest valid archive fact still wins.
        }
      }
      const target = this.resolveUnarchiveTarget(originalParentId);
      if (!target) {
        return {
          result: {
            status: "conflict" as const,
            reason: "original_parent_unavailable" as const,
          },
          failedDeliveryIds: [] as string[],
        };
      }
      const {
        parentId: targetParentId,
        fellBackToRoot,
        originalMissing,
      } = target;

      const subtree = new Set([id, ...this.store.getDescendantTaskIds(id)]);
      if (subtree.has(targetParentId)) {
        return {
          result: {
            status: "conflict" as const,
            reason: "original_parent_unavailable" as const,
          },
          failedDeliveryIds: [] as string[],
        };
      }

      if (
        task.title !== null &&
        this.store.db
          .prepare(
            `SELECT 1 AS present FROM tasks
             WHERE parent_id = ? AND title = ? AND deleted_at IS NULL AND id != ?
             LIMIT 1`,
          )
          .get(targetParentId, task.title, id) !== undefined
      ) {
        return {
          result: {
            status: "conflict" as const,
            reason: "title_conflict" as const,
          },
          failedDeliveryIds: [] as string[],
        };
      }

      const parentPath =
        this.store.getTaskPath(targetParentId) ?? targetParentId;
      this.store.db
        .prepare("UPDATE tasks SET parent_id = ? WHERE id = ?")
        .run(targetParentId, id);
      const bodyEntries: Array<{ label: string; value: string }> = [
        { label: "parent", value: `${parentPath} (${targetParentId})` },
      ];
      if (fellBackToRoot) {
        bodyEntries.push({
          label: "original parent",
          value:
            originalParentId === null
              ? "none recorded"
              : `${originalParentId} no longer exists`,
        });
      }
      const message = {
        kind: "task_unarchive" as const,
        title: "Task unarchived",
        body: formatFieldBlock(bodyEntries),
      };
      this.store.saveEvent(
        id,
        "system_message",
        {
          ...message,
          parentId: targetParentId,
          parentPath,
          ...(fellBackToRoot
            ? {
                fellBackToRoot: true,
                originalParentId: originalParentId ?? undefined,
                originalParentMissing: originalMissing,
              }
            : {}),
        },
        { from_ref: "system" },
      );

      const { failedDeliveryIds, externalParent } =
        this.detachExternalParentOnUnarchive(id, task.title, options);

      return {
        result: {
          status: "unarchived" as const,
          taskId: id,
          parentId: targetParentId,
          parentPath,
          message,
          ...(externalParent ? { externalParent } : {}),
        },
        failedDeliveryIds,
      };
    });
    this.store.broadcastDeliveryStatus(out.failedDeliveryIds);
    return out.result;
  }

  private detachExternalParentOnUnarchive(
    id: string,
    title: string | null,
    options?: TaskDeleteStoreOptions,
  ): {
    failedDeliveryIds: string[];
    externalParent?: { remoteHost: string; remoteTaskId: string };
  } {
    const externalLink = this.remoteRelations.getExternalParentLink(id);
    if (!externalLink) return { failedDeliveryIds: [] };
    const hadOpenExternalAccount =
      options?.hasOpenExternalAccount?.(id, externalLink.remote_task_id) ===
      true;
    const failedAt = Date.now();
    const edgeQueued = this.store.db
      .prepare(
        `SELECT d.id FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         WHERE d.recipient_task_id = ?
           AND d.status = 'queued'
           AND d.source_remote_role = 'parent'
           AND d.source_remote_host = ?
           AND m.source_task_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM outbox o WHERE o.delivery_id = d.id
           )`,
      )
      .all(id, externalLink.remote_host, externalLink.remote_task_id) as Array<{
      id: string;
    }>;
    const failedDeliveryIds: string[] = [];
    for (const row of edgeQueued) {
      if (
        this.store.transitionDeliveryStatusInTransaction(
          row.id,
          "queued",
          "failed",
          failedAt,
          "link_mismatch",
        )
      ) {
        failedDeliveryIds.push(row.id);
      }
    }
    this.remoteRelations.deleteExternalParentLinkInTransaction(id);
    this.enqueueChildLeftInTransaction(
      {
        remoteHost: externalLink.remote_host,
        remoteTaskId: externalLink.remote_task_id,
        title,
      },
      id,
      hadOpenExternalAccount && failedDeliveryIds.length === 0,
    );
    return {
      failedDeliveryIds,
      externalParent: {
        remoteHost: externalLink.remote_host,
        remoteTaskId: externalLink.remote_task_id,
      },
    };
  }

  /**
   * Mark queued collaboration between the archived subtree and everything
   * outside it as interrupted, in both directions. `queued` means it has not
   * reached ACP. Rows already handed over (or failed and awaiting a retry) are
   * left untouched; a failed row keeps its real reason.
   */
  private markQueuedDeliveriesAcrossSubtreeBoundary(
    seedTaskId: string,
  ): string[] {
    const failedAt = Date.now();
    const ids = (
      this.store.db
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
             SELECT id FROM tasks WHERE id = ?
             UNION
             SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
           )
           SELECT d.id FROM deliveries d
           JOIN messages m ON m.id = d.message_id
           WHERE d.status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM outbox o WHERE o.delivery_id = d.id
             )
             AND (
               (m.source_task_id IN (SELECT id FROM subtree))
               <> (m.direct_target_task_id IN (SELECT id FROM subtree))
             )
             AND NOT (
               d.source_remote_role = 'child'
               AND d.source_remote_host IS NOT NULL
               AND d.recipient_task_id IN (SELECT id FROM subtree)
               AND EXISTS (
                 SELECT 1 FROM remote_tasks r
                 WHERE r.remote_role = 'child'
                   AND r.remote_host = d.source_remote_host
                   AND r.remote_task_id = m.source_task_id
                   AND r.local_task_id = d.recipient_task_id
               )
             )`,
        )
        .all(seedTaskId) as Array<{ id: string }>
    ).map((row) => row.id);
    if (ids.length === 0) return ids;
    return ids.filter((id) =>
      this.store.transitionDeliveryStatusInTransaction(
        id,
        "queued",
        "failed",
        failedAt,
        "archived_edge_cut",
      ),
    );
  }

  deleteTask(
    id: string,
    options?: TaskDeleteStoreOptions,
  ): {
    mode: "hard" | "soft";
    affected: TaskDelete[];
  } {
    if (this.store.isRootTaskId(id)) {
      throw new Error("Root task cannot be deleted");
    }
    return this.store.writeBindings(() => this.deleteTaskInScope(id, options));
  }

  deleteTaskInScope(
    id: string,
    options?: TaskDeleteStoreOptions,
  ): {
    mode: "hard" | "soft";
    affected: TaskDelete[];
  } {
    if (this.store.isRootTaskId(id)) {
      throw new Error("Root task cannot be deleted");
    }
    const affected: TaskDelete[] = [];
    const children = this.store.listChildren(id);
    for (const childId of children) {
      affected.push(...this.deleteTaskInScope(childId, options).affected);
    }
    const binding = this.store.getCurrentExecutionBinding(id);
    const beforeBinding: ExecutionBinding | null = binding
      ? { agentId: binding.agent_key, sessionId: binding.agent_session_id }
      : null;
    this.store.db
      .prepare("DELETE FROM shares WHERE task_id = ? AND shared_at IS NULL")
      .run(id);
    const taskDeleteInfo = this.store.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM shares WHERE task_id = ? AND shared_at IS NOT NULL) AS active_shares,
           t.title,
           r.remote_host,
           r.remote_task_id
         FROM tasks t
         LEFT JOIN remote_tasks r
           ON r.local_task_id = t.id AND r.remote_role = 'parent'
         WHERE t.id = ?`,
      )
      .get(id, id) as
      | {
          active_shares: number;
          title: string | null;
          remote_host: string | null;
          remote_task_id: string | null;
        }
      | undefined;
    const activeShareCount = taskDeleteInfo?.active_shares ?? 0;
    const externalParent: DeletedExternalParent | undefined =
      taskDeleteInfo?.remote_host && taskDeleteInfo.remote_task_id
        ? {
            remoteHost: taskDeleteInfo.remote_host,
            remoteTaskId: taskDeleteInfo.remote_task_id,
            title: taskDeleteInfo.title,
          }
        : undefined;
    const hadOpenExternalAccount =
      externalParent !== undefined &&
      options?.hasOpenExternalAccount?.(id, externalParent.remoteTaskId) ===
        true;
    this.store.db.prepare("DELETE FROM client_ops WHERE task_id = ?").run(id);
    if (activeShareCount > 0) {
      return this.softDeleteTaskInScope({
        id,
        binding,
        beforeBinding,
        externalParent,
        hadOpenExternalAccount,
        affected,
      });
    }
    return this.hardDeleteTaskInScope({
      id,
      binding,
      beforeBinding,
      externalParent,
      hadOpenExternalAccount,
      affected,
    });
  }

  private softDeleteTaskInScope(input: {
    id: string;
    binding: ReturnType<StoreInternal["getCurrentExecutionBinding"]>;
    beforeBinding: ExecutionBinding | null;
    externalParent: DeletedExternalParent | undefined;
    hadOpenExternalAccount: boolean;
    affected: TaskDelete[];
  }): { mode: "soft"; affected: TaskDelete[] } {
    const {
      id,
      binding,
      beforeBinding,
      externalParent,
      hadOpenExternalAccount,
      affected,
    } = input;
    this.store.db
      .prepare("UPDATE tasks SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), id);
    this.store.db
      .prepare("DELETE FROM agent_sessions WHERE task_id = ?")
      .run(id);
    this.remoteRelations.deleteRemoteRelationsForLocalTaskInTransaction(id);
    if (externalParent) {
      this.enqueueChildLeftInTransaction(
        externalParent,
        id,
        hadOpenExternalAccount,
      );
    }
    this.store.collectBindingChange(id, beforeBinding);
    affected.unshift({
      id,
      mode: "soft",
      agentSessionId: binding?.agent_session_id ?? null,
      agentId: binding?.agent_key ?? null,
      ...(externalParent ? { externalParent } : {}),
    });
    return { mode: "soft", affected };
  }

  private hardDeleteTaskInScope(input: {
    id: string;
    binding: ReturnType<StoreInternal["getCurrentExecutionBinding"]>;
    beforeBinding: ExecutionBinding | null;
    externalParent: DeletedExternalParent | undefined;
    hadOpenExternalAccount: boolean;
    affected: TaskDelete[];
  }): { mode: "hard"; affected: TaskDelete[] } {
    const {
      id,
      binding,
      beforeBinding,
      externalParent,
      hadOpenExternalAccount,
      affected,
    } = input;
    this.store.reparentChildrenToRoot(id);
    const failedDeliveryIds =
      this.store.failOutstandingDeliveriesForDeletedTask(id);
    if (externalParent) {
      const edgeFailed = this.anyFailedDeliveryOnExternalParentEdge(
        failedDeliveryIds,
        id,
        externalParent,
      );
      this.enqueueChildLeftInTransaction(
        externalParent,
        id,
        hadOpenExternalAccount && !edgeFailed,
      );
    }
    this.store.db.prepare("DELETE FROM events WHERE task_id = ?").run(id);
    this.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    this.store.collectBindingChange(id, beforeBinding);
    affected.unshift({
      id,
      mode: "hard",
      agentSessionId: binding?.agent_session_id ?? null,
      agentId: binding?.agent_key ?? null,
      ...(externalParent ? { externalParent } : {}),
    });
    return { mode: "hard", affected };
  }

  private anyFailedDeliveryOnExternalParentEdge(
    deliveryIds: readonly string[],
    recipientTaskId: string,
    externalParent: DeletedExternalParent,
  ): boolean {
    if (deliveryIds.length === 0) return false;
    const placeholders = deliveryIds.map(() => "?").join(", ");
    return (
      this.store.db
        .prepare(
          `SELECT 1 FROM deliveries d
           JOIN messages m ON m.id = d.message_id
           WHERE d.id IN (${placeholders})
             AND d.recipient_task_id = ?
             AND d.source_remote_role = 'parent'
             AND d.source_remote_host = ?
             AND m.source_task_id = ?
           LIMIT 1`,
        )
        .get(
          ...deliveryIds,
          recipientTaskId,
          externalParent.remoteHost,
          externalParent.remoteTaskId,
        ) !== undefined
    );
  }

  private enqueueChildLeftInTransaction(
    externalParent: DeletedExternalParent,
    childTaskId: string,
    accountOpen: boolean,
  ): void {
    const data: LinkRelationData = {
      kind: "child_left",
      parentTaskId: externalParent.remoteTaskId,
      childTaskId,
      accountOpen,
    };
    this.linkOutbox.enqueueOutboxInTransaction({
      entryId: randomUUID(),
      remoteRole: "parent",
      remoteHost: externalParent.remoteHost,
      category: "relation",
      dataJson: stringifyLinkData(data),
      deliveryId: null,
      createdAt: Date.now(),
    });
  }
}
