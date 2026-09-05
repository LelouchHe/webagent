import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const ROOT_TASK_ID = "root";

/** One task removed by a delete (the requested id or a cascaded descendant). */
export interface TaskDelete {
  id: string;
  /** How this task itself was removed: hard (row gone) or soft (tombstoned). */
  mode: "hard" | "soft";
  /** The ACP execution bound at deletion time, for explicit retirement. */
  agentSessionId: string | null;
}

export type WorkflowStatus = "running" | "idle" | "blocked" | "done";

export interface TaskRow {
  id: string;
  cwd: string;
  title: string | null;
  /** Initial creation record; clear never replays it automatically. */
  brief: string;
  workflow_status: WorkflowStatus;
  model: string | null;
  mode: string | null;
  reasoning_effort: string | null;
  source: string;
  created_at: string;
  last_active_at: string;
  /** epoch ms; NULL = live; non-NULL = soft-deleted (kept alive for active shares). */
  deleted_at: number | null;
  /** Optional parent WebAgent task; the reserved Root has NULL. */
  parent_id: string | null;
  /** Agent-generated context handoff waiting for the next real prompt. */
  pending_compact_summary: string | null;
}

export interface AgentSessionRow {
  agent_key: string;
  agent_session_id: string;
  task_id: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  task_id: string;
  seq: number;
  type: string;
  data: string; // JSON
  /** Origin marker: 'user' | 'system' | 'agent' | 'msg:<id>'. */
  from_ref: string;
  created_at: string;
}

export interface SubscriptionRow {
  id: number;
  endpoint: string;
  auth: string;
  p256dh: string;
  created_at: string;
}

/** A pending unbound notification -- posted via /api/v1/messages with to="user". */
export interface MessageRow {
  id: string;
  from_ref: string;
  from_label: string | null;
  to_ref: string;
  deliver: string;
  dedup_key: string | null;
  title: string;
  body: string;
  cwd: string | null;
  created_at: number;
}

export interface MessageInput {
  id: string;
  from_ref: string;
  from_label: string | null;
  to_ref: string;
  deliver: string;
  dedup_key: string | null;
  title: string;
  body: string;
  cwd: string | null;
  created_at: number;
}

export class MessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`Message not found: ${messageId}`);
    this.name = "MessageNotFoundError";
  }
}

export type CollaborationActor = "user" | "agent" | "system";
export type CollaborationProjectionRole = "source" | "target" | "supervisor";
export type CollaborationDeliveryStatus =
  | "queued"
  | "draining"
  | "delivered"
  | "failed";

export interface CollaborationMessageRow {
  id: string;
  source_task_id: string;
  direct_target_task_id: string;
  source_actor: CollaborationActor;
  body: string;
  created_at: number;
}

export interface CollaborationProjectionRow {
  message_id: string;
  task_id: string;
  role: CollaborationProjectionRole;
  created_at: number;
}

export interface CollaborationDeliveryRow {
  id: string;
  message_id: string;
  recipient_task_id: string;
  idempotency_key: string;
  status: CollaborationDeliveryStatus;
  queued_at: number;
  claimed_at: number | null;
  delivered_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
}

export interface CollaborationMessageInput {
  id: string;
  deliveryId: string;
  sourceTaskId: string;
  directTargetTaskId: string;
  sourceActor: CollaborationActor;
  body: string;
  createdAt?: number;
}

/** share-plan §4.1 full row shape. */
export interface ShareRow {
  token: string;
  task_id: string;
  /** epoch ms; NULL = preview (un-activated). */
  shared_at: number | null;
  share_snapshot_seq: number;
  /** NULL = fall back to config.share.ttl_hours; 0 = never expire; >0 = custom hours. */
  ttl_hours: number | null;
  display_name: string | null;
  owner_label: string | null;
  created_at: number;
  last_accessed_at: number | null;
}

/** Summary projection for GET /api/v1/shares (joins task title). */
export interface ShareSummaryRow {
  token: string;
  task_id: string;
  task_title: string | null;
  shared_at: number | null;
  created_at: number;
  display_name: string | null;
  owner_label: string | null;
  share_snapshot_seq: number;
  ttl_hours: number | null;
  last_accessed_at: number | null;
}

export interface AttachmentRow {
  id: string;
  task_id: string;
  kind: string;
  name: string;
  mime: string;
  size: number;
  realpath: string;
  upload_seq: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface AttachmentInput {
  id: string;
  taskId: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  realpath: string;
  width?: number | null;
  height?: number | null;
}

export class Store {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  readonly agentKey: string;

  constructor(dataDir: string, agentKey: string) {
    if (!agentKey) throw new Error("agentKey is required");
    this.agentKey = agentKey;
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "webagent.db"));
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.assertSupportedSchema();
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private assertSupportedSchema(): void {
    const legacy = this.db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      )
      .get() as { present: number } | undefined;
    const requiredColumns: Record<string, string[]> = {
      tasks: [
        "id",
        "cwd",
        "title",
        "brief",
        "workflow_status",
        "parent_id",
        "pending_compact_summary",
        "model",
        "mode",
        "reasoning_effort",
        "source",
        "deleted_at",
        "created_at",
        "last_active_at",
      ],
      agent_sessions: [
        "agent_key",
        "agent_session_id",
        "task_id",
        "created_at",
      ],
      events: [
        "id",
        "task_id",
        "seq",
        "type",
        "data",
        "created_at",
        "from_ref",
      ],
      shares: [
        "token",
        "task_id",
        "shared_at",
        "share_snapshot_seq",
        "ttl_hours",
        "display_name",
        "owner_label",
        "created_at",
        "last_accessed_at",
      ],
      attachments: [
        "id",
        "task_id",
        "kind",
        "name",
        "mime",
        "size",
        "realpath",
        "upload_seq",
        "width",
        "height",
        "created_at",
      ],
      inbox_messages: [
        "id",
        "from_ref",
        "from_label",
        "to_ref",
        "deliver",
        "dedup_key",
        "title",
        "body",
        "cwd",
        "created_at",
      ],
      messages: [
        "id",
        "source_task_id",
        "direct_target_task_id",
        "source_actor",
        "body",
        "created_at",
      ],
      message_projections: ["message_id", "task_id", "role", "created_at"],
      deliveries: [
        "id",
        "message_id",
        "recipient_task_id",
        "idempotency_key",
        "status",
        "queued_at",
        "claimed_at",
        "delivered_at",
        "failed_at",
        "failure_reason",
      ],
    };
    const incompatible = legacy
      ? "legacy sessions table"
      : Object.entries(requiredColumns).find(([table, columns]) => {
          const exists = this.db
            .prepare(
              "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(table) as { present: number } | undefined;
          if (!exists) return false;
          const actual = new Set(
            (
              this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                name: string;
              }>
            ).map((column) => column.name),
          );
          return (
            columns.some((column) => !actual.has(column)) ||
            [...actual].some((column) => !columns.includes(column)) ||
            (table === "events" &&
              this.db
                .prepare(
                  "SELECT 1 AS present FROM events WHERE from_ref IS NULL LIMIT 1",
                )
                .get() !== undefined)
          );
        })?.[0];
    if (incompatible) {
      throw new Error(
        `Pre-1.0 data directory detected (${incompatible}). Back up and delete the data directory before restarting: ${this.dataDir}`,
      );
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT,
        brief TEXT NOT NULL DEFAULT '',
        workflow_status TEXT NOT NULL DEFAULT 'idle'
          CHECK (workflow_status IN ('running', 'idle', 'blocked', 'done')),
        parent_id TEXT REFERENCES tasks(id),
        pending_compact_summary TEXT,
        model TEXT,
        mode TEXT,
        reasoning_effort TEXT,
        source TEXT NOT NULL DEFAULT 'auto',
        deleted_at INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_key TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (agent_key, agent_session_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_task
        ON agent_sessions(task_id)
        WHERE task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        from_ref TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL UNIQUE,
        auth TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
    `);

    // inbox_messages — pending unbound notifications. POST /api/v1/messages with
    // `to = "user"` lands here; consumeMessageTx transactionally moves the
    // content into an existing ACP-backed task's events and deletes the
    // row. Bound messages (to = task id) skip this table entirely and go
    // straight to `events`.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id              TEXT PRIMARY KEY,
        from_ref        TEXT NOT NULL,
        from_label      TEXT,
        to_ref          TEXT NOT NULL,
        deliver         TEXT NOT NULL DEFAULT 'push',
        dedup_key       TEXT,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL,
        cwd             TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_messages_created ON inbox_messages (created_at);
      CREATE INDEX IF NOT EXISTS idx_inbox_messages_dedup ON inbox_messages (to_ref, dedup_key);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        source_task_id TEXT NOT NULL,
        direct_target_task_id TEXT NOT NULL,
        source_actor TEXT NOT NULL CHECK (source_actor IN ('user', 'agent', 'system')),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_source_created
        ON messages (source_task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_target_created
        ON messages (direct_target_task_id, created_at);

      CREATE TABLE IF NOT EXISTS message_projections (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('source', 'target', 'supervisor')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_projections_task_created
        ON message_projections (task_id, created_at);

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        recipient_task_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'draining', 'delivered', 'failed')),
        queued_at INTEGER NOT NULL,
        claimed_at INTEGER,
        delivered_at INTEGER,
        failed_at INTEGER,
        failure_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status_queued
        ON deliveries (recipient_task_id, status, queued_at);
    `);

    // client-server-split M2: idempotency for mutating REST calls. Stores
    // the cached response per (task_id, client_op_id) so retries (after
    // network/SSE reconnect) return the same result instead of re-executing
    // side effects.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_ops (
        task_id   TEXT NOT NULL,
        client_op_id TEXT NOT NULL,
        result_json  TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (task_id, client_op_id)
      );
    `);

    // recent_paths: LRU path list for /new menu
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recent_paths (
        cwd TEXT PRIMARY KEY,
        last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_parent_title_live
        ON tasks (parent_id, title)
        WHERE deleted_at IS NULL AND title IS NOT NULL;
    `);

    // Secondary index for events queried by (task_id, type, created_at)
    // -- used by inbox/message consume queries.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_events_type ON events(task_id, type, created_at)",
    );

    // shares — public read-only share links (share-plan §4.1).
    // State machine: preview (shared_at NULL) → active (shared_at set).
    // Revocation = hard-delete the row (no audit trail kept).
    // Multiple active siblings per task allowed (v4 multi-share).
    // Partial unique index enforces at most one un-activated preview per
    // task at any time.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        token TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        shared_at INTEGER,
        share_snapshot_seq INTEGER NOT NULL,
        ttl_hours INTEGER,
        display_name TEXT,
        owner_label TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
        last_accessed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_shares_task ON shares(task_id, created_at DESC);
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS shares_one_active_preview
        ON shares(task_id)
        WHERE shared_at IS NULL;
    `);

    // attachments — server-managed file uploads bound to a task.
    // Lifecycle = task lifecycle: FK CASCADE removes the row when the
    // task row is deleted (hard-delete path). Tombstoned (soft-deleted)
    // tasks keep the row alive so the share viewer can still resolve
    // file references for active shares.
    //
    // upload_seq = MAX(events.seq) at upload time. The share proxy uses
    // `upload_seq <= shares.share_snapshot_seq` to refuse files uploaded
    // after the share was published, without growing a second seq axis.
    //
    // realpath is stored after fs.realpath so the bridge / permission
    // interceptor can compare paths without re-resolving symlinks on
    // every request.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id           TEXT PRIMARY KEY,
        task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        name         TEXT NOT NULL,
        mime         TEXT NOT NULL,
        size         INTEGER NOT NULL,
        realpath     TEXT NOT NULL,
        upload_seq   INTEGER NOT NULL,
        width        INTEGER,
        height       INTEGER,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
    `);

    // owner_prefs — key-value store for owner-scoped defaults (display_name,
    // last /by selection, etc). Single-user model = single owner scope.
    // Stored as plain key/value so we don't grow a new table per pref.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_prefs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
    `);
  }

  /**
   * Ensure the reserved Root record exists and attach existing live tasks
   * that do not have a parent. This is additive and keeps every old task,
   * event, attachment, and share intact; the Root's ACP binding is created by
   * SessionManager after the bridge is ready.
   *
   * The default title is the literal "root": it is only applied while the
   * title is still NULL, so a user rename survives restarts. The non-null
   * title also keeps title generation from ever overwriting Root.
   */
  ensureRootTask(cwd: string): TaskRow {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO tasks (id, cwd, source, parent_id, title) VALUES (?, ?, 'root', NULL, 'root')",
        )
        .run("root", cwd);
      this.db
        .prepare("UPDATE tasks SET parent_id = NULL WHERE id = ?")
        .run("root");
      // Default title only while NULL so a user rename survives restarts.
      this.db
        .prepare(
          "UPDATE tasks SET title = 'root' WHERE id = ? AND title IS NULL",
        )
        .run("root");
      this.db
        .prepare(
          `UPDATE tasks
           SET parent_id = ?
           WHERE id != ? AND parent_id IS NULL AND deleted_at IS NULL`,
        )
        .run("root", "root");
      return this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get("root") as TaskRow;
    })();
  }

  createTask(
    id: string,
    cwd: string,
    source: string = "auto",
    agentSessionId: string = id,
    parentId: string | null = null,
    opts: {
      title?: string;
      brief?: string;
      workflowStatus?: WorkflowStatus;
      initialMessage?: Omit<CollaborationMessageInput, "directTargetTaskId">;
    } = {},
  ): TaskRow {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tasks
           (id, cwd, source, parent_id, title, brief, workflow_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          cwd,
          source,
          parentId,
          opts.title ?? id,
          opts.brief ?? "",
          opts.workflowStatus ?? "idle",
        );
      this.db
        .prepare(
          "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id) VALUES (?, ?, ?)",
        )
        .run(this.agentKey, agentSessionId, id);
      if (opts.initialMessage) {
        this.createCollaborationMessage({
          ...opts.initialMessage,
          directTargetTaskId: id,
        });
      }
      return this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(id) as TaskRow;
    })();
  }

  listTasks(opts?: { source?: string }): TaskRow[] {
    if (opts?.source) {
      return this.db
        .prepare(
          `SELECT s.* FROM tasks s
           JOIN agent_sessions a ON a.task_id = s.id
           WHERE a.agent_key = ? AND s.source = ? AND s.deleted_at IS NULL
           ORDER BY COALESCE(s.last_active_at, s.created_at) DESC`,
        )
        .all(this.agentKey, opts.source) as TaskRow[];
    }
    return this.db
      .prepare(
        `SELECT s.* FROM tasks s
         JOIN agent_sessions a ON a.task_id = s.id
         WHERE a.agent_key = ? AND s.deleted_at IS NULL
         ORDER BY COALESCE(s.last_active_at, s.created_at) DESC`,
      )
      .all(this.agentKey) as TaskRow[];
  }

  /** Returns live tasks only. Soft-deleted (tombstone) rows are hidden. */
  getTask(id: string): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT s.* FROM tasks s
         JOIN agent_sessions a ON a.task_id = s.id
         WHERE s.id = ? AND a.agent_key = ? AND s.deleted_at IS NULL`,
      )
      .get(id, this.agentKey) as TaskRow | undefined;
  }

  registerInternalAgentSession(agentSessionId: string): AgentSessionRow {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_sessions (agent_key, agent_session_id, task_id) VALUES (?, ?, NULL)",
      )
      .run(this.agentKey, agentSessionId);
    const row = this.db
      .prepare(
        "SELECT * FROM agent_sessions WHERE agent_key = ? AND agent_session_id = ?",
      )
      .get(this.agentKey, agentSessionId) as AgentSessionRow;
    if (row.task_id) {
      throw new Error("Agent reused a user-visible task ID internally");
    }
    return row;
  }

  getAgentSessionId(taskId: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT agent_session_id FROM agent_sessions WHERE agent_key = ? AND task_id = ?",
        )
        .get(this.agentKey, taskId) as { agent_session_id: string } | undefined
    )?.agent_session_id;
  }

  getTaskId(agentSessionId: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT task_id FROM agent_sessions WHERE agent_key = ? AND agent_session_id = ? AND task_id IS NOT NULL",
        )
        .get(this.agentKey, agentSessionId) as { task_id: string } | undefined
    )?.task_id;
  }

  getAgentSessionBinding(taskId: string): AgentSessionRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM agent_sessions WHERE agent_key = ? AND task_id = ?",
      )
      .get(this.agentKey, taskId) as AgentSessionRow | undefined;
  }

  /**
   * Replace the current ACP execution for a stable WebAgent task.
   * The previous binding row is removed: its execution is explicitly
   * retired by the caller and must never accept WebAgent events again.
   */
  rotateAgentSession(
    taskId: string,
    agentSessionId: string,
    cwd?: string,
  ): AgentSessionRow {
    return this.db.transaction(() => {
      const current = this.getAgentSessionBinding(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      // Persist a requested cwd even when the agent returns the same
      // execution id (no-op rotation); the caller decides whether to retire
      // based on whether the binding actually moved.
      if (cwd !== undefined) {
        this.db
          .prepare("UPDATE tasks SET cwd = ? WHERE id = ?")
          .run(cwd, taskId);
      }
      if (current.agent_session_id === agentSessionId) return current;

      this.db
        .prepare(
          "DELETE FROM agent_sessions WHERE agent_key = ? AND task_id = ?",
        )
        .run(this.agentKey, taskId);
      this.db
        .prepare(
          "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id) VALUES (?, ?, ?)",
        )
        .run(this.agentKey, agentSessionId, taskId);

      return this.getAgentSessionBinding(taskId)!;
    })();
  }

  /** Bind an ACP execution to an existing WebAgent task without creating a row. */
  bindAgentSession(taskId: string, agentSessionId: string): AgentSessionRow {
    return this.db.transaction(() => {
      if (!this.getTaskIncludingDeleted(taskId)) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const current = this.getAgentSessionBinding(taskId);
      if (current) {
        if (current.agent_session_id === agentSessionId) return current;
        throw new Error(`Task already has an ACP binding: ${taskId}`);
      }
      this.db
        .prepare(
          "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id) VALUES (?, ?, ?)",
        )
        .run(this.agentKey, agentSessionId, taskId);
      return this.getAgentSessionBinding(taskId)!;
    })();
  }

  ownsTask(taskId: string): boolean {
    return this.getAgentSessionBinding(taskId) !== undefined;
  }

  /**
   * Returns a task row even if soft-deleted. Used by the public share
   * viewer, which must keep working after the owner deletes the source
   * task (events stay alive as long as any active share references them).
   */
  getTaskIncludingDeleted(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
  }

  /**
   * Return the current lineage from Root (or the highest surviving ancestor)
   * to a task. Includes soft-deleted ancestors so callers can detect a
   * broken/hidden parent chain and revalidate it after acquiring a lock.
   * Returns undefined for a missing row or a cycle.
   */
  getTaskLineage(id: string): string[] | undefined {
    const reversed: string[] = [];
    const seen = new Set<string>();
    let current: TaskRow | undefined = this.getTaskIncludingDeleted(id);
    while (current) {
      if (seen.has(current.id)) return undefined;
      seen.add(current.id);
      reversed.push(current.id);
      if (current.parent_id === null) return reversed.reverse();
      current = this.getTaskIncludingDeleted(current.parent_id);
    }
    return undefined;
  }

  /** Re-parent surviving children of a hard-deleted task under Root so the
   *  FK on parent_id stays valid. Root is guaranteed to exist post-boot
   *  (ensureRootTask runs before listen). No-op when there are no children. */
  private reparentChildrenToRoot(parentId: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET parent_id = ? WHERE parent_id = ? AND id != ? AND id != ?",
      )
      .run(ROOT_TASK_ID, parentId, parentId, ROOT_TASK_ID);
  }

  /** Direct child ids of a task (excluding itself and Root), in any order. */
  private listChildren(parentId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM tasks WHERE parent_id = ? AND id != ? AND id != ?",
        )
        .all(parentId, parentId, ROOT_TASK_ID) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  /**
   * Every descendant of a task, transitively (used to gate destructive
   * operations such as the DELETE busy check against in-flight children).
   */
  getDescendantTaskIds(rootId: string): string[] {
    const out: string[] = [];
    const queue = [rootId];
    while (queue.length > 0) {
      for (const child of this.listChildren(queue.pop()!)) {
        queue.push(child);
        out.push(child);
      }
    }
    return out;
  }

  hasActiveShare(taskId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM shares WHERE task_id = ? AND shared_at IS NOT NULL LIMIT 1",
      )
      .get(taskId) as { present: number } | undefined;
    return row !== undefined;
  }

  /**
   * Reset Root while preserving its stable anchor row. Every descendant is
   * deleted using the ordinary task/share lifecycle, then Root's own event
   * history and attachments are cleared. The caller rotates Root's ACP
   * execution separately so this method remains a synchronous DB operation.
   */
  resetRootTask(): { affected: TaskDelete[] } {
    const root = this.getTaskIncludingDeleted(ROOT_TASK_ID);
    if (!root) throw new Error("Root task not found");
    if (this.hasActiveShare(ROOT_TASK_ID)) {
      throw new Error("Root task has an active share");
    }

    const reset = this.db.transaction(() => {
      const affected: TaskDelete[] = [];
      for (const childId of this.listChildren(ROOT_TASK_ID)) {
        affected.push(...this.deleteTask(childId).affected);
      }
      this.db
        .prepare("DELETE FROM shares WHERE task_id = ? AND shared_at IS NULL")
        .run(ROOT_TASK_ID);
      this.db.prepare("DELETE FROM events WHERE task_id = ?").run(ROOT_TASK_ID);
      this.db
        .prepare("DELETE FROM client_ops WHERE task_id = ?")
        .run(ROOT_TASK_ID);
      this.db
        .prepare("DELETE FROM attachments WHERE task_id = ?")
        .run(ROOT_TASK_ID);
      this.db
        .prepare("UPDATE tasks SET pending_compact_summary = NULL WHERE id = ?")
        .run(ROOT_TASK_ID);
      return { affected };
    })();
    return reset;
  }

  /**
   * Delete a task and every descendant task recursively. The
   * parent/child hierarchy is a hard ownership link, so the deletion is
   * immediate and needs no confirmation (a confirmation step is deferred
   * until a tree UI exists). Each affected task follows its own share
   * rules: a task with active shares is tombstoned (kept so share
   * viewers still resolve) and its binding removed; a share-tombstoned
   * descendant of a hard-deleted parent is re-parented under Root.
   *
   * Returns every affected task with its deletion mode and the ACP
   * execution bound at deletion time, so callers can retire executions,
   * clean up in-memory state, and broadcast `task_deleted` per id.
   */
  deleteTask(id: string): {
    mode: "hard" | "soft";
    affected: TaskDelete[];
  } {
    if (id === ROOT_TASK_ID) {
      throw new Error("Root task cannot be deleted");
    }
    const affected: TaskDelete[] = [];
    // Delete descendants first (children before parents) so the FK on
    // parent_id can never block the parent's own row removal.
    const children = this.listChildren(id);
    for (const childId of children) {
      affected.push(...this.deleteTask(childId).affected);
    }
    const binding = this.getAgentSessionBinding(id);
    // Drop preview shares regardless — they are owner-only drafts and
    // share the task's lifecycle by design.
    this.db
      .prepare("DELETE FROM shares WHERE task_id = ? AND shared_at IS NULL")
      .run(id);
    const activeShareCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM shares WHERE task_id = ? AND shared_at IS NOT NULL",
        )
        .get(id) as { n: number }
    ).n;
    this.db.prepare("DELETE FROM client_ops WHERE task_id = ?").run(id);
    if (activeShareCount > 0) {
      // Soft-delete: keep events + tasks row so public share viewers
      // can still resolve. The owner-side binding is retired like a hard
      // delete; revokeShare() / reapTombstoneIfOrphaned() finishes the job
      // once the last share is gone.
      this.db
        .prepare("UPDATE tasks SET deleted_at = ? WHERE id = ?")
        .run(Date.now(), id);
      if (binding) {
        this.db
          .prepare(
            "DELETE FROM agent_sessions WHERE agent_key = ? AND agent_session_id = ?",
          )
          .run(this.agentKey, binding.agent_session_id);
      }
      affected.unshift({
        id,
        mode: "soft",
        agentSessionId: binding?.agent_session_id ?? null,
      });
      return { mode: "soft", affected };
    }
    // Hard delete: re-parent any survivor (share-tombstoned descendants)
    // under Root, then drop events and the row (agent_sessions cascades).
    this.reparentChildrenToRoot(id);
    this.failOutstandingDeliveriesForDeletedTask(id);
    this.db.prepare("DELETE FROM events WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    affected.unshift({
      id,
      mode: "hard",
      agentSessionId: binding?.agent_session_id ?? null,
    });
    return { mode: "hard", affected };
  }

  /**
   * Hard-delete events + tasks row for a task that has been soft-
   * deleted and whose last share was just revoked. No-op if the task
   * is still live (deleted_at IS NULL) or still has active shares.
   * Returns true if a tombstone was reaped.
   */
  reapTombstoneIfOrphaned(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM tasks WHERE id = ? AND deleted_at IS NOT NULL")
      .get(taskId) as { id: string } | undefined;
    if (!row) return false;
    const remaining = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM shares WHERE task_id = ?")
        .get(taskId) as { n: number }
    ).n;
    if (remaining > 0) return false;
    // Its live children were deleted when it was tombstoned; any survivor
    // (a share-tombstoned descendant of this tombstone) still references it
    // and must be re-parented under Root before the row goes away.
    this.reparentChildrenToRoot(taskId);
    this.failOutstandingDeliveriesForDeletedTask(taskId);
    this.db.prepare("DELETE FROM events WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    return true;
  }

  /** Delete tasks that have zero events and are older than minAgeS seconds. Returns IDs deleted. */
  deleteEmptyTasks(minAgeS: number): Array<{
    id: string;
    agentSessionId: string | null;
  }> {
    const empties = this.db
      .prepare(
        `
      SELECT s.id, a.agent_session_id FROM tasks s
      JOIN agent_sessions a ON a.task_id = s.id
      LEFT JOIN events e ON e.task_id = s.id
      WHERE e.id IS NULL
        AND s.id != ?
        AND a.agent_key = ?
        AND s.deleted_at IS NULL
        AND strftime('%s', 'now') - strftime('%s', s.created_at) >= ?
    `,
      )
      .all(ROOT_TASK_ID, this.agentKey, minAgeS) as Array<{
      id: string;
      agent_session_id: string;
    }>;
    if (empties.length === 0) return [];
    const del = this.db.prepare("DELETE FROM tasks WHERE id = ?");
    const removed: Array<{ id: string; agentSessionId: string | null }> = [];
    for (const r of empties) {
      // A junk task may still be someone's parent; keep the children by
      // re-parenting them under Root instead of deleting them.
      this.reparentChildrenToRoot(r.id);
      this.failOutstandingDeliveriesForDeletedTask(r.id);
      del.run(r.id);
      removed.push({ id: r.id, agentSessionId: r.agent_session_id });
    }
    return removed;
  }

  updateTaskTitle(id: string, title: string): void {
    this.db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(title, id);
  }

  updateTaskWorkflowStatus(id: string, status: WorkflowStatus): void {
    this.db
      .prepare("UPDATE tasks SET workflow_status = ? WHERE id = ?")
      .run(status, id);
  }

  updateTaskLastActive(id: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET last_active_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?",
      )
      .run(id);
  }

  /** Return the hidden summary waiting to be prepended to the next prompt. */
  getPendingCompactSummary(id: string): string | null {
    const row = this.db
      .prepare("SELECT pending_compact_summary FROM tasks WHERE id = ?")
      .get(id) as { pending_compact_summary: string | null } | undefined;
    return row?.pending_compact_summary ?? null;
  }

  /**
   * Persist the visible assistant summary and its hidden pending copy together.
   * The latter is consumed only when the next real prompt is accepted.
   */
  saveCompactSummary(taskId: string, summary: string): EventRow {
    return this.db.transaction(() => {
      const seq = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE task_id = ?",
          )
          .get(taskId) as { next: number }
      ).next;
      this.db
        .prepare(
          "INSERT INTO events (task_id, seq, type, data, from_ref) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          taskId,
          seq,
          "assistant_message",
          JSON.stringify({ text: summary }),
          "agent",
        );
      this.db
        .prepare("UPDATE tasks SET pending_compact_summary = ? WHERE id = ?")
        .run(summary, taskId);
      return this.db
        .prepare("SELECT * FROM events WHERE task_id = ? AND seq = ?")
        .get(taskId, seq) as EventRow;
    })();
  }

  /** Clear a pending summary, optionally only when it is still the expected value. */
  clearPendingCompactSummary(id: string, expected?: string): boolean {
    const result =
      expected === undefined
        ? this.db
            .prepare(
              "UPDATE tasks SET pending_compact_summary = NULL WHERE id = ?",
            )
            .run(id)
        : this.db
            .prepare(
              "UPDATE tasks SET pending_compact_summary = NULL WHERE id = ? AND pending_compact_summary = ?",
            )
            .run(id, expected);
    return result.changes > 0;
  }

  /** Update a config option value (model, mode, reasoning_effort) for a task. */
  updateTaskConfig(id: string, configId: string, value: string): void {
    const column = (
      {
        model: "model",
        mode: "mode",
        reasoning_effort: "reasoning_effort",
        thought_level: "reasoning_effort",
      } as Record<string, string>
    )[configId];
    if (!column) return;
    this.db
      .prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`)
      .run(value, id);
  }

  saveEvent(
    taskId: string,
    type: string,
    data: Record<string, unknown> = {},
    opts?: { from_ref?: string },
  ): EventRow {
    const seq = (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE task_id = ?",
        )
        .get(taskId) as { next: number }
    ).next;

    // Origin marker is required. Every writer must pass an explicit value;
    // missing/empty fails loudly so a forgotten retrofit can't silently
    // mis-bucket a row in production. Valid values:
    //   'user' | 'system' | 'agent' | 'msg:<id>'.
    const fromRef = opts?.from_ref;
    if (!fromRef) {
      throw new Error(
        `saveEvent: from_ref is required (type=${type} task=${taskId.slice(0, 8)}) — pass { from_ref: 'user' | 'system' | 'agent' | 'msg:<id>' }`,
      );
    }

    this.db
      .prepare(
        "INSERT INTO events (task_id, seq, type, data, from_ref) VALUES (?, ?, ?, ?, ?)",
      )
      .run(taskId, seq, type, JSON.stringify(data), fromRef);

    return this.db
      .prepare("SELECT * FROM events WHERE task_id = ? AND seq = ?")
      .get(taskId, seq) as EventRow;
  }

  getEvents(
    taskId: string,
    opts?: {
      excludeThinking?: boolean;
      afterSeq?: number;
      beforeSeq?: number;
      limit?: number;
    },
  ): EventRow[] {
    const hasLimit = opts?.limit != null && opts.limit > 0;
    const conditions = ["task_id = ?"];
    const params: unknown[] = [taskId];
    if (opts?.afterSeq != null) {
      conditions.push("seq > ?");
      params.push(opts.afterSeq);
    }
    if (opts?.beforeSeq != null) {
      conditions.push("seq < ?");
      params.push(opts.beforeSeq);
    }
    if (opts?.excludeThinking) {
      conditions.push("type != 'thinking'");
    }
    const where = conditions.join(" AND ");

    if (hasLimit) {
      // Fetch the last N matching rows: subquery orders DESC with LIMIT,
      // outer query re-orders ASC so the page is in chronological order.
      const sql = `SELECT * FROM (SELECT * FROM events WHERE ${where} ORDER BY seq DESC LIMIT ?) ORDER BY seq`;
      params.push(opts.limit);
      return this.db.prepare(sql).all(...params) as EventRow[];
    }
    return this.db
      .prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq`)
      .all(...params) as EventRow[];
  }

  getEventCount(taskId: string, opts?: { excludeThinking?: boolean }): number {
    let query = "SELECT COUNT(*) as count FROM events WHERE task_id = ?";
    const params: unknown[] = [taskId];
    if (opts?.excludeThinking) {
      query += " AND type != 'thinking'";
    }
    return (this.db.prepare(query).get(...params) as { count: number }).count;
  }

  /** Highest seq of any stored event for this task (0 when empty). */
  getLastEventSeq(taskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?",
      )
      .get(taskId) as { seq: number };
    return row.seq;
  }

  /** Check if the most recent agent turn lacks a completion or error terminal event. */
  hasInterruptedTurn(taskId: string): boolean {
    const row = this.db
      .prepare(
        `
      SELECT 1 FROM events
      WHERE task_id = ? AND type = 'user_message'
        AND seq > COALESCE(
          (
            SELECT MAX(seq) FROM events
            WHERE task_id = ? AND type IN ('prompt_done', 'error')
          ),
          0
        )
      LIMIT 1
    `,
      )
      .get(taskId, taskId);
    return Boolean(row);
  }

  // --- Push subscriptions ---

  saveSubscription(endpoint: string, auth: string, p256dh: string): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, auth, p256dh)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET auth = excluded.auth, p256dh = excluded.p256dh`,
      )
      .run(endpoint, auth, p256dh);
  }

  removeSubscription(endpoint: string): void {
    this.db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .run(endpoint);
  }

  getAllSubscriptions(): SubscriptionRow[] {
    return this.db
      .prepare("SELECT * FROM push_subscriptions")
      .all() as SubscriptionRow[];
  }

  // --- Recent paths ---

  touchRecentPath(cwd: string): void {
    this.db
      .prepare(
        `INSERT INTO recent_paths (cwd, last_used_at)
       VALUES (?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
       ON CONFLICT(cwd) DO UPDATE SET last_used_at = strftime('%Y-%m-%d %H:%M:%f', 'now')`,
      )
      .run(cwd);
  }

  listRecentPaths(opts?: {
    limit?: number;
    ttlDays?: number;
  }): Array<{ cwd: string; last_used_at: string }> {
    const ttl = opts?.ttlDays ?? 0;
    if (ttl > 0) {
      this.db
        .prepare(
          "DELETE FROM recent_paths WHERE last_used_at < strftime('%Y-%m-%d %H:%M:%f', 'now', ?)",
        )
        .run(`-${ttl} days`);
    }
    const limit = opts?.limit;
    if (limit && limit > 0) {
      return this.db
        .prepare(
          "SELECT cwd, last_used_at FROM recent_paths ORDER BY last_used_at DESC LIMIT ?",
        )
        .all(limit) as Array<{ cwd: string; last_used_at: string }>;
    }
    return this.db
      .prepare(
        "SELECT cwd, last_used_at FROM recent_paths ORDER BY last_used_at DESC",
      )
      .all() as Array<{ cwd: string; last_used_at: string }>;
  }

  deleteRecentPath(cwd: string): void {
    this.db.prepare("DELETE FROM recent_paths WHERE cwd = ?").run(cwd);
  }

  // ===== inbox messages (pending unbound notifications) =====

  createMessage(input: MessageInput): void {
    this.db
      .prepare(
        `INSERT INTO inbox_messages
         (id, from_ref, from_label, to_ref, deliver, dedup_key, title, body, cwd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.from_ref,
        input.from_label,
        input.to_ref,
        input.deliver,
        input.dedup_key,
        input.title,
        input.body,
        input.cwd,
        input.created_at,
      );
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db
      .prepare("SELECT * FROM inbox_messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
  }

  listUnprocessed(): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM inbox_messages ORDER BY created_at DESC")
      .all() as MessageRow[];
  }

  countUnprocessed(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM inbox_messages")
      .get() as { count: number };
    return row.count;
  }

  deleteMessage(id: string): number {
    const info = this.db
      .prepare("DELETE FROM inbox_messages WHERE id = ?")
      .run(id);
    return info.changes;
  }

  /**
   * Delete unprocessed messages whose created_at is older than the given
   * epoch-ms threshold. Returns the number of rows removed.
   */
  deleteOlderThan(thresholdMs: number): number {
    const info = this.db
      .prepare("DELETE FROM inbox_messages WHERE created_at < ?")
      .run(thresholdMs);
    return info.changes;
  }

  /** Find an existing unprocessed message matching (to_ref, dedup_key) for server-side supersede. */
  findBySupersede(
    to_ref: string,
    dedup_key: string | null,
  ): MessageRow | undefined {
    if (!dedup_key) return undefined;
    return this.db
      .prepare(
        "SELECT * FROM inbox_messages WHERE to_ref = ? AND dedup_key = ? LIMIT 1",
      )
      .get(to_ref, dedup_key) as MessageRow | undefined;
  }

  /**
   * Atomically move a pending message into an existing task. Task
   * lifecycle belongs to SessionManager because ACP creation is asynchronous
   * and cannot participate in this SQLite transaction.
   */
  consumeMessageTx(
    messageId: string,
    taskId: string,
  ): { taskId: string; alreadyConsumed: boolean } {
    const existing = this.findConsumedMessageTask(messageId);
    if (existing) {
      return { taskId: existing, alreadyConsumed: true };
    }

    const row = this.getMessage(messageId);
    if (!row) {
      throw new MessageNotFoundError(messageId);
    }

    const tx = this.db.transaction(() => {
      this.saveEvent(
        taskId,
        "message",
        {
          message_id: row.id,
          from_ref: row.from_ref,
          from_label: row.from_label,
          title: row.title,
          body: row.body,
          cwd: row.cwd,
        },
        { from_ref: row.from_ref },
      );
      const del = this.db
        .prepare("DELETE FROM inbox_messages WHERE id = ?")
        .run(messageId);
      if (del.changes === 0) {
        throw new MessageNotFoundError(messageId);
      }
    });
    tx();

    return { taskId, alreadyConsumed: false };
  }

  findConsumedMessageTask(messageId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT task_id FROM events
         WHERE type = 'message'
           AND json_extract(data, '$.message_id') = ?
         LIMIT 1`,
      )
      .get(messageId) as { task_id: string } | undefined;
    return row?.task_id;
  }

  // ===== collaboration messages =====

  private requireLiveTask(taskId: string): TaskRow {
    const task = this.getTaskIncludingDeleted(taskId);
    if (task?.deleted_at !== null) {
      throw new Error(`Live task not found: ${taskId}`);
    }
    return task;
  }

  private lowestCommonAncestor(
    sourceTaskId: string,
    targetTaskId: string,
  ): string {
    const sourceLineage = this.getTaskLineage(sourceTaskId);
    const targetLineage = this.getTaskLineage(targetTaskId);
    if (!sourceLineage || !targetLineage) {
      throw new Error("Cannot determine collaboration task lineage");
    }
    const sourceAncestors = new Set(sourceLineage);
    for (let index = targetLineage.length - 1; index >= 0; index--) {
      const taskId = targetLineage[index];
      if (sourceAncestors.has(taskId)) return taskId;
    }
    throw new Error("Collaboration tasks have no common ancestor");
  }

  /**
   * Persist one cross-task fact, its task-timeline projections, and the sole
   * target Delivery in one SQLite transaction. Delivery mechanics live above
   * this Store API; this method never resolves paths or applies reachability
   * policy.
   */
  createCollaborationMessage(input: CollaborationMessageInput): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  } {
    const createdAt = input.createdAt ?? Date.now();
    return this.db.transaction(() => {
      if (input.sourceTaskId === input.directTargetTaskId) {
        throw new Error("Collaboration source and target must differ");
      }
      this.requireLiveTask(input.sourceTaskId);
      this.requireLiveTask(input.directTargetTaskId);
      const lcaTaskId = this.lowestCommonAncestor(
        input.sourceTaskId,
        input.directTargetTaskId,
      );
      this.db
        .prepare(
          `INSERT INTO messages
           (id, source_task_id, direct_target_task_id, source_actor, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.sourceTaskId,
          input.directTargetTaskId,
          input.sourceActor,
          input.body,
          createdAt,
        );
      const insertProjection = this.db.prepare(
        `INSERT INTO message_projections (message_id, task_id, role, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      insertProjection.run(input.id, input.sourceTaskId, "source", createdAt);
      insertProjection.run(
        input.id,
        input.directTargetTaskId,
        "target",
        createdAt,
      );
      if (
        lcaTaskId !== input.sourceTaskId &&
        lcaTaskId !== input.directTargetTaskId
      ) {
        insertProjection.run(input.id, lcaTaskId, "supervisor", createdAt);
      }
      for (const projection of this.listCollaborationProjections(input.id)) {
        this.saveEvent(
          projection.task_id,
          "system_message",
          {
            kind: "collaboration",
            messageId: input.id,
            sourceTaskId: input.sourceTaskId,
            sourceLabel:
              this.getTask(input.sourceTaskId)?.title ??
              input.sourceTaskId.slice(0, 8),
            targetTaskId: input.directTargetTaskId,
            targetLabel:
              this.getTask(input.directTargetTaskId)?.title ??
              input.directTargetTaskId.slice(0, 8),
            role: projection.role,
            body: input.body,
          },
          { from_ref: `msg:${input.id}` },
        );
      }
      this.db
        .prepare(
          `INSERT INTO deliveries
           (id, message_id, recipient_task_id, idempotency_key, status, queued_at)
           VALUES (?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          input.deliveryId,
          input.id,
          input.directTargetTaskId,
          `${input.id}:${input.directTargetTaskId}`,
          createdAt,
        );
      return {
        message: this.getCollaborationMessage(input.id)!,
        delivery: this.getCollaborationDelivery(input.deliveryId)!,
      };
    })();
  }

  getCollaborationMessage(id: string): CollaborationMessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      | CollaborationMessageRow
      | undefined;
  }

  listCollaborationProjections(
    messageId: string,
  ): Array<Pick<CollaborationProjectionRow, "task_id" | "role">> {
    return this.db
      .prepare(
        `SELECT task_id, role FROM message_projections
         WHERE message_id = ?
         ORDER BY CASE role
           WHEN 'source' THEN 0
           WHEN 'target' THEN 1
           ELSE 2
         END, task_id`,
      )
      .all(messageId) as Array<
      Pick<CollaborationProjectionRow, "task_id" | "role">
    >;
  }

  getCollaborationDelivery(id: string): CollaborationDeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as
      | CollaborationDeliveryRow
      | undefined;
  }

  /** Read-only queued count; lets a caller skip busy-turn churn entirely. */
  countQueuedDeliveries(recipientTaskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM deliveries WHERE recipient_task_id = ? AND status = 'queued'",
      )
      .get(recipientTaskId) as { count: number };
    return row.count;
  }

  /** Atomically claim every currently queued Delivery for one target task. */
  claimQueuedDeliveries(recipientTaskId: string): CollaborationDeliveryRow[] {
    const claimedAt = Date.now();
    return this.db.transaction(() => {
      const ids = this.db
        .prepare(
          `SELECT id FROM deliveries
           WHERE recipient_task_id = ? AND status = 'queued'
           ORDER BY queued_at, id`,
        )
        .all(recipientTaskId) as Array<{ id: string }>;
      const claim = this.db.prepare(
        `UPDATE deliveries
         SET status = 'draining', claimed_at = ?
         WHERE id = ? AND status = 'queued'`,
      );
      const claimed: CollaborationDeliveryRow[] = [];
      for (const { id } of ids) {
        if (claim.run(claimedAt, id).changes !== 1) continue;
        const delivery = this.getCollaborationDelivery(id);
        if (delivery) claimed.push(delivery);
      }
      return claimed;
    })();
  }

  markCollaborationDeliveriesDelivered(
    ids: string[],
    deliveredAt = Date.now(),
  ): void {
    const mark = this.db.prepare(
      `UPDATE deliveries
       SET status = 'delivered', delivered_at = ?, failure_reason = NULL, failed_at = NULL
       WHERE id = ? AND status = 'draining'`,
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) mark.run(deliveredAt, id);
    });
    tx();
  }

  failCollaborationDeliveries(
    ids: string[],
    failureReason: string,
    failedAt = Date.now(),
  ): void {
    const fail = this.db.prepare(
      `UPDATE deliveries
       SET status = 'failed', failed_at = ?, failure_reason = ?
       WHERE id = ? AND status = 'draining'`,
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) fail.run(failedAt, failureReason, id);
    });
    tx();
  }

  failOutstandingDeliveriesForTaskClear(taskId: string): void {
    const failedAt = Date.now();
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'failed', failed_at = ?, failure_reason =
           CASE status
             WHEN 'queued' THEN 'cleared_before_delivery'
             ELSE 'cleared_during_delivery'
           END
         WHERE recipient_task_id = ? AND status IN ('queued', 'draining')`,
      )
      .run(failedAt, taskId);
  }

  /** Preserve the fact while recording that a deleted target cannot receive it. */
  private failOutstandingDeliveriesForDeletedTask(taskId: string): void {
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'failed', failed_at = ?, failure_reason = 'target_deleted'
         WHERE recipient_task_id = ? AND status IN ('queued', 'draining')`,
      )
      .run(Date.now(), taskId);
  }

  // --- client-server-split M2: client_ops idempotency ---

  /**
   * Look up a previously-cached response for (taskId, clientOpId).
   * Returns the parsed result or null if no cached entry exists.
   */
  getClientOp(taskId: string, clientOpId: string): unknown {
    const row = this.db
      .prepare(
        "SELECT result_json FROM client_ops WHERE task_id = ? AND client_op_id = ?",
      )
      .get(taskId, clientOpId) as { result_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.result_json);
    } catch {
      return null;
    }
  }

  /**
   * Cache a successful response for (taskId, clientOpId). Uses
   * INSERT OR IGNORE so a concurrent winner is preserved.
   */
  saveClientOp(taskId: string, clientOpId: string, result: unknown): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO client_ops (task_id, client_op_id, result_json) VALUES (?, ?, ?)",
      )
      .run(taskId, clientOpId, JSON.stringify(result));
  }

  /** Prune client_ops rows older than `maxAgeMs` (milliseconds). Returns rows deleted. */
  pruneClientOps(maxAgeMs: number): number {
    const seconds = Math.floor(maxAgeMs / 1000);
    const info = this.db
      .prepare(
        "DELETE FROM client_ops WHERE strftime('%s','now') - strftime('%s', created_at) >= ?",
      )
      .run(seconds);
    return info.changes;
  }

  // ===== attachments (uploads-plan v2.6 §1.2) =====

  /**
   * Insert a new attachment row. upload_seq is computed as
   * `COALESCE(MAX(events.seq), 0)` for the task at insert time. Callers
   * must have already written the file under
   * <data_dir>/tasks/<sid>/attachments/<id>.<ext> and resolved its
   * realpath. The row is bound by FK CASCADE to its task.
   */
  insertAttachment(input: AttachmentInput): AttachmentRow {
    const seqRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE task_id = ?",
      )
      .get(input.taskId) as { s: number };
    const uploadSeq = seqRow.s;
    this.db
      .prepare(
        `INSERT INTO attachments
           (id, task_id, kind, name, mime, size, realpath, upload_seq, width, height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.taskId,
        input.kind,
        input.name,
        input.mime,
        input.size,
        input.realpath,
        uploadSeq,
        input.width ?? null,
        input.height ?? null,
      );
    return this.db
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .get(input.id) as AttachmentRow;
  }

  /** Look up an attachment row by (task_id, id). */
  getAttachment(taskId: string, id: string): AttachmentRow | undefined {
    return this.db
      .prepare("SELECT * FROM attachments WHERE task_id = ? AND id = ?")
      .get(taskId, id) as AttachmentRow | undefined;
  }

  /**
   * For the permission interceptor: list all attachment realpaths for a
   * task so we can compare against `toolCall.locations[].path` after
   * realpath-ing each side. The set is small (≤ a few hundred per
   * task) so we hand back an in-memory array.
   */
  listAttachmentRealpaths(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT realpath FROM attachments WHERE task_id = ?")
      .all(taskId) as { realpath: string }[];
    return rows.map((r) => r.realpath);
  }

  /**
   * For the egress label-rewrite (CLAUDE.md "Attachment label egress
   * rewrite"): list each attachment's id, user-supplied name, and
   * realpath for a task. Caller (task-manager label cache)
   * derives the label string `<name> [#<id4>]`. Pure DB read; no
   * realpath syscalls (the stored realpath is already resolved at
   * upload time).
   */
  listAttachmentLabels(
    taskId: string,
  ): Array<{ id: string; name: string; realpath: string }> {
    const rows = this.db
      .prepare("SELECT id, name, realpath FROM attachments WHERE task_id = ?")
      .all(taskId) as Array<{ id: string; name: string; realpath: string }>;
    return rows;
  }

  /**
   * For the share viewer / GET serve path: look up an attachment by the
   * filename portion of its URL (`<id>.<ext>`). The id is the uuid prefix
   * of the file segment.
   */
  getAttachmentByFile(taskId: string, file: string): AttachmentRow | undefined {
    const dot = file.indexOf(".");
    const id = dot === -1 ? file : file.slice(0, dot);
    return this.getAttachment(taskId, id);
  }

  close(): void {
    this.db.close();
  }

  // ===== shares (share-plan §4.1) =====

  /**
   * Insert a new preview row. Caller must have flushed buffered chunks
   * and computed snapshotSeq in the same synchronous tick (share-plan
   * §4.3 R1-c2). Returns the inserted row.
   *
   * May throw SQLITE_CONSTRAINT_UNIQUE on shares_one_active_preview;
   * callers handle via findActivePreviewByTask fallback (§4.3 R2-c2).
   */
  insertSharePreview(input: {
    token: string;
    taskId: string;
    snapshotSeq: number;
    ttlHours?: number | null;
    displayName?: string | null;
    ownerLabel?: string | null;
  }): ShareRow {
    this.db
      .prepare(
        `INSERT INTO shares (token, task_id, share_snapshot_seq, ttl_hours, display_name, owner_label)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.token,
        input.taskId,
        input.snapshotSeq,
        input.ttlHours ?? null,
        input.displayName ?? null,
        input.ownerLabel ?? null,
      );
    return this.getShareByToken(input.token)!;
  }

  /** SELECT the single un-activated preview for this task (partial unique). */
  findActivePreviewByTask(taskId: string): ShareRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM shares
       WHERE task_id = ? AND shared_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as ShareRow | undefined;
  }

  getShareByToken(token: string): ShareRow | undefined {
    return this.db
      .prepare("SELECT * FROM shares WHERE token = ?")
      .get(token) as ShareRow | undefined;
  }

  /**
   * Activate preview: shared_at NULL → now(). Returns true if row moved
   * (0 → 1 rows affected). False if preview already activated, revoked,
   * or token doesn't exist.
   */
  activateShare(
    token: string,
    opts?: { displayName?: string | null; ownerLabel?: string | null },
  ): boolean {
    const now = Date.now();
    let sql = "UPDATE shares SET shared_at = ?";
    const params: unknown[] = [now];
    if (opts && "displayName" in opts) {
      sql += ", display_name = ?";
      params.push(opts.displayName ?? null);
    }
    if (opts && "ownerLabel" in opts) {
      sql += ", owner_label = ?";
      params.push(opts.ownerLabel ?? null);
    }
    sql += " WHERE token = ? AND shared_at IS NULL";
    params.push(token);
    const info = this.db.prepare(sql).run(...params);
    return info.changes > 0;
  }

  /** Hard-delete a share row. Returns true if the row existed. */
  revokeShare(token: string): boolean {
    const info = this.db
      .prepare("DELETE FROM shares WHERE token = ?")
      .run(token);
    return info.changes > 0;
  }

  /** Update only owner_label (PATCH route). Caller validates the value first. */
  updateShareOwnerLabel(token: string, label: string | null): boolean {
    const info = this.db
      .prepare("UPDATE shares SET owner_label = ? WHERE token = ?")
      .run(label, token);
    return info.changes > 0;
  }

  /** Update only display_name (PATCH route). Caller validates the value first. */
  updateShareDisplayName(token: string, name: string | null): boolean {
    const info = this.db
      .prepare("UPDATE shares SET display_name = ? WHERE token = ?")
      .run(name, token);
    return info.changes > 0;
  }

  /** Owner list — every share row (preview + active). */
  listOwnerShares(): ShareSummaryRow[] {
    return this.db
      .prepare(
        `SELECT
         s.token AS token,
         s.task_id AS task_id,
         t.title AS task_title,
         s.shared_at AS shared_at,
         s.created_at AS created_at,
         s.display_name AS display_name,
         s.owner_label AS owner_label,
         s.share_snapshot_seq AS share_snapshot_seq,
         s.ttl_hours AS ttl_hours,
         s.last_accessed_at AS last_accessed_at
       FROM shares s
       JOIN agent_sessions a ON a.task_id = s.task_id
       LEFT JOIN tasks t ON t.id = s.task_id
       WHERE a.agent_key = ?
       ORDER BY s.created_at DESC`,
      )
      .all(this.agentKey) as ShareSummaryRow[];
  }

  /**
   * One-time write of last_accessed_at (share-plan §4.1 R2 ENG-6a +
   * OPS-R2-1): only fire when currently NULL to avoid write amplification.
   * Returns true if the field was set by this call.
   */
  touchShareAccessed(token: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE shares SET last_accessed_at = ? WHERE token = ? AND last_accessed_at IS NULL",
      )
      .run(Date.now(), token);
    return info.changes > 0;
  }

  /**
   * Lazy prune of preview rows older than 24h (share-plan §4.1).
   * `now` is injectable for tests. Activated rows (shared_at set) are
   * NEVER touched — only orphaned previews are GC'd.
   */
  pruneStalePreviews(now: number = Date.now()): number {
    const cutoff = now - 24 * 60 * 60 * 1000;
    const info = this.db
      .prepare("DELETE FROM shares WHERE shared_at IS NULL AND created_at < ?")
      .run(cutoff);
    return info.changes;
  }

  // ===== owner_prefs =====

  getOwnerPref(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM owner_prefs WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setOwnerPref(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO owner_prefs (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  clearOwnerPref(key: string): void {
    this.db.prepare("DELETE FROM owner_prefs WHERE key = ?").run(key);
  }
}
