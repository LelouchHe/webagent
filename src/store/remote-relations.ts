import { canonicalCwd } from "../cwd-path.ts";
import type { WorkflowStatus } from "../shared/workflow-status.ts";
import {
  emptyExecutionSlot,
  type LinkRemoteRole,
  type TaskRow,
} from "../store.ts";
import type { StoreInternal } from "./internal.ts";

export class RemoteRelationsStore {
  private readonly store: StoreInternal;
  private hasExternalParents = false;

  constructor(store: StoreInternal) {
    this.store = store;
  }

  setHasExternalParents(value: boolean): void {
    this.hasExternalParents = value;
  }

  createDeferredRemoteTask(input: {
    id: string;
    cwd: string;
    source: string;
    agentId: string;
    externalParentId: string;
    remoteHost: string;
    title?: string;
    workflowStatus?: WorkflowStatus;
    creationAnchor: Record<string, unknown>;
  }): TaskRow {
    if (this.store.isRootTaskId(input.id)) {
      throw new Error(
        `Reserved Root id cannot be created as an ordinary task: ${input.id}`,
      );
    }
    if (!input.externalParentId.trim()) {
      throw new Error("invalid_external_parent");
    }
    const created = this.store.writeBindings(() => {
      if (!this.store.getTaskIncludingDeleted(this.store.getRootTaskId())) {
        this.store.insertRootRow(input.cwd);
      }
      const now = Date.now();
      this.store.db
        .prepare(
          `INSERT INTO tasks
           (id, cwd, source, parent_id, title, workflow_status, created_at, last_active_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          canonicalCwd(input.cwd),
          input.source,
          input.title ?? input.id,
          input.workflowStatus ?? "idle",
          now,
          now,
        );
      this.store.insertBindingRow(
        input.id,
        input.agentId,
        emptyExecutionSlot(input.id),
      );
      this.store.collectBindingChange(input.id, null);
      this.store.db
        .prepare(
          `INSERT INTO remote_tasks
             (local_task_id, remote_task_id, remote_role, remote_host)
             VALUES (?, ?, 'parent', ?)`,
        )
        .run(input.id, input.externalParentId, input.remoteHost);
      this.store.saveEvent(input.id, "system_message", input.creationAnchor, {
        from_ref: "system",
      });
      return this.store.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(input.id) as TaskRow;
    });
    this.hasExternalParents = true;
    return created;
  }

  listRemoteChildren(): Array<{
    local_task_id: string;
    remote_task_id: string;
    remote_host: string;
  }> {
    return this.store.db
      .prepare(
        `SELECT local_task_id, remote_task_id, remote_host
           FROM remote_tasks
           WHERE remote_role = 'child'`,
      )
      .all() as Array<{
      local_task_id: string;
      remote_task_id: string;
      remote_host: string;
    }>;
  }

  getRemoteChild(
    remoteHost: string,
    remoteTaskId: string,
  ):
    | {
        local_task_id: string;
        remote_task_id: string;
        remote_host: string;
      }
    | undefined {
    return this.store.db
      .prepare(
        `SELECT local_task_id, remote_task_id, remote_host
           FROM remote_tasks
           WHERE remote_role = 'child' AND remote_host = ? AND remote_task_id = ?`,
      )
      .get(remoteHost, remoteTaskId) as
      | {
          local_task_id: string;
          remote_task_id: string;
          remote_host: string;
        }
      | undefined;
  }

  getExternalParentId(taskId: string): string | null {
    const row = this.store.db
      .prepare(
        `SELECT remote_task_id FROM remote_tasks
         WHERE local_task_id = ? AND remote_role = 'parent'
         LIMIT 1`,
      )
      .get(taskId) as { remote_task_id: string } | undefined;
    return row?.remote_task_id ?? null;
  }

  getExternalParentLink(taskId: string):
    | {
        remote_task_id: string;
        remote_host: string;
      }
    | undefined {
    if (!this.hasExternalParents) return undefined;
    return this.store.db
      .prepare(
        `SELECT remote_task_id, remote_host FROM remote_tasks
         WHERE local_task_id = ? AND remote_role = 'parent'
         LIMIT 1`,
      )
      .get(taskId) as
      | {
          remote_task_id: string;
          remote_host: string;
        }
      | undefined;
  }

  getLatestInboundSourceLabel(
    recipientTaskId: string,
    sourceTaskId: string,
    remoteRole: LinkRemoteRole,
    remoteHost: string,
  ): string | null {
    const row = this.store.db
      .prepare(
        `SELECT d.source_label
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         WHERE d.recipient_task_id = ?
           AND m.source_task_id = ?
           AND d.source_remote_role = ?
           AND d.source_remote_host = ?
         ORDER BY d.rowid DESC
         LIMIT 1`,
      )
      .get(recipientTaskId, sourceTaskId, remoteRole, remoteHost) as
      { source_label: string | null } | undefined;
    const trimmed = row?.source_label?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  }

  getRemoteChildTitle(
    localParentTaskId: string,
    remoteTaskId: string,
  ): string | null {
    const row = this.store.db
      .prepare(
        `SELECT json_extract(data, '$.taskTitle') AS title
         FROM events
         WHERE task_id = ? AND type = 'system_message'
           AND json_extract(data, '$.kind') = 'task_created'
           AND json_extract(data, '$.taskId') = ?
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(localParentTaskId, remoteTaskId) as { title: unknown } | undefined;
    return typeof row?.title === "string" && row.title.trim().length > 0
      ? row.title
      : null;
  }

  recordRemoteChild(
    localParentTaskId: string,
    remoteTaskId: string,
    remoteHost: string,
    creation?: { data: Record<string, unknown>; fromRef: string },
  ): boolean {
    return this.store.db.transaction(() => {
      const existing = this.store.db
        .prepare(
          `SELECT local_task_id, remote_host FROM remote_tasks
           WHERE remote_role = 'child' AND remote_task_id = ?`,
        )
        .get(remoteTaskId) as
        { local_task_id: string; remote_host: string } | undefined;
      if (existing) {
        if (
          existing.local_task_id === localParentTaskId &&
          existing.remote_host === remoteHost
        ) {
          return false;
        }
        throw new Error("remote_child_link_conflict");
      }
      this.store.db
        .prepare(
          `INSERT INTO remote_tasks
           (local_task_id, remote_task_id, remote_role, remote_host)
           VALUES (?, ?, 'child', ?)`,
        )
        .run(localParentTaskId, remoteTaskId, remoteHost);
      if (creation) {
        this.store.saveEvent(
          localParentTaskId,
          "system_message",
          creation.data,
          {
            from_ref: creation.fromRef,
          },
        );
      }
      return true;
    })();
  }
}
