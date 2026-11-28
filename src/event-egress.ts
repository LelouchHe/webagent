import type Database from "better-sqlite3";
import type { EventRow, Store } from "./store.ts";
import type { TaskManager } from "./task-manager.ts";
import type { AgentEvent } from "./types.ts";
import { attachCollaborationDeliveryStatus } from "./collaboration-message.ts";
import { enrichStoredEventsForDisplay } from "./attachment-labels.ts";
import { reSignAttachmentUrlsInJson } from "./auth.ts";
import { isoFromMillis } from "./shared/time.ts";
import { projectMarkdownImageReferences } from "./markdown-image-references.ts";

export interface StoredEventEgress {
  id: number;
  task_id: string;
  seq: number;
  type: string;
  data: string;
  from_ref: string;
  created_at: string;
}

export interface EventFeedEntry {
  feed: string;
  pos: number;
  prev: number;
  data: StoredEventEgress;
}

export interface EventEgressDeps {
  store: Store;
  tasks?: TaskManager;
  attachmentSecret?: Buffer;
}

/**
 * Shared egress projection for persisted `events` rows (used by both
 * `GET /api/v1/tasks/:id/events` and outer-commit SSE feed publication).
 *
 * Raw DB rows remain untouched; this adds collaboration delivery state,
 * attachment display labels (never rewriting `permission_request.rawInput`),
 * fresh signed attachment URLs, and ISO `created_at`.
 */
export function projectStoredEvents(
  rows: readonly EventRow[],
  deps: EventEgressDeps,
): StoredEventEgress[] {
  if (rows.length === 0) return [];
  const copies = rows.map((row) => ({ ...row }));

  attachCollaborationDeliveryStatus(copies, (messageIds) => {
    const deliveries =
      deps.store.getCollaborationDeliveriesForMessages(messageIds);
    return new Map(
      [...deliveries].map(([messageId, row]) => [
        messageId,
        {
          status: row.status,
          deliveredAt: row.delivered_at,
          failureReason: row.failure_reason,
        },
      ]),
    );
  });

  if (deps.tasks && typeof deps.tasks.getLabelMap === "function") {
    const byTask = new Map<string, EventRow[]>();
    for (const row of copies) {
      let bucket = byTask.get(row.task_id);
      if (!bucket) {
        bucket = [];
        byTask.set(row.task_id, bucket);
      }
      bucket.push(row);
    }
    for (const [taskId, bucket] of byTask) {
      const labelMap = deps.tasks.getLabelMap(taskId);
      if (labelMap.size > 0) {
        enrichStoredEventsForDisplay(bucket, labelMap);
      }
    }
  }

  if (deps.attachmentSecret) {
    for (const row of copies) {
      if (typeof row.data === "string" && row.data.includes("/attachments/")) {
        row.data = reSignAttachmentUrlsInJson(row.data, deps.attachmentSecret);
      }
    }
  }

  return copies.map((row) => ({
    ...row,
    created_at: isoFromMillis(row.created_at),
  }));
}

export function toEventFeedEntries(
  rows: readonly StoredEventEgress[],
): EventFeedEntry[] {
  return rows.map((row) => ({
    feed: row.task_id,
    pos: row.seq,
    prev: row.seq - 1,
    data: row,
  }));
}

/**
 * Thin legacy projection for per-task SSE (`/api/v1/tasks/:id/events/stream`)
 * so producers maintain a single committed feed while per-task SSE consumers
 * (such as `/api/beta/prompt` and `Last-Event-ID` replay) keep their wire shape.
 */
export function projectLegacyPerTaskEvent(
  row: StoredEventEgress,
): AgentEvent | null {
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    return {
      ...parsed,
      type: row.type,
      taskId: row.task_id,
    } as AgentEvent;
  } catch {
    return null;
  }
}

export function projectImageReferences(
  store: Store,
  taskId: string,
  attachmentSecret?: Buffer,
): unknown {
  const allEvents = store.getEvents(taskId);
  const projected = projectMarkdownImageReferences(store, taskId, allEvents);
  if (!attachmentSecret) return projected;
  return JSON.parse(
    reSignAttachmentUrlsInJson(JSON.stringify(projected), attachmentSecret),
  ) as unknown;
}

export interface CommittedEventTracker {
  record(row: EventRow): void;
  onCommitted(observer: (rows: readonly EventRow[]) => void): void;
}

/**
 * Wraps `db.transaction` once so every nested SQLite savepoint checkpoints and
 * rewinds collected `events` rows on rollback, and publishes synchronously in
 * order only after the outermost SQLite transaction commits.
 */
export function installCommittedEventTracker(
  db: Database.Database,
): CommittedEventTracker {
  const observers: Array<(rows: readonly EventRow[]) => void> = [];
  let pending: EventRow[] = [];
  let depth = 0;

  const flush = (): void => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    for (const observer of observers) observer(batch);
  };

  const rawTransaction = db.transaction.bind(db);
  const wrapRunner = <T extends (...args: never[]) => unknown>(
    runner: T,
  ): T => {
    const wrapped = ((...args: Parameters<T>) => {
      const isOuter = !db.inTransaction;
      try {
        const result = runner(...args);
        if (isOuter && !db.inTransaction && depth === 0) {
          flush();
        }
        return result;
      } catch (error) {
        if (isOuter && !db.inTransaction && depth === 0) {
          pending = [];
        }
        throw error;
      }
    }) as T;
    return wrapped;
  };

  db.transaction = (<F extends (...args: never[]) => unknown>(fn: F) => {
    const inner = rawTransaction((...args: Parameters<F>) => {
      const checkpoint = pending.length;
      depth += 1;
      try {
        return fn(...args);
      } catch (error) {
        pending.length = checkpoint;
        throw error;
      } finally {
        depth -= 1;
      }
    });
    const invoke = wrapRunner(inner) as unknown as Database.Transaction<F>;
    invoke.default = wrapRunner((...args: Parameters<F>) =>
      inner.default(...args),
    ) as unknown as Database.Transaction<F>["default"];
    invoke.deferred = wrapRunner((...args: Parameters<F>) =>
      inner.deferred(...args),
    ) as unknown as Database.Transaction<F>["deferred"];
    invoke.immediate = wrapRunner((...args: Parameters<F>) =>
      inner.immediate(...args),
    ) as unknown as Database.Transaction<F>["immediate"];
    invoke.exclusive = wrapRunner((...args: Parameters<F>) =>
      inner.exclusive(...args),
    ) as unknown as Database.Transaction<F>["exclusive"];
    return invoke;
  }) as typeof db.transaction;

  return {
    record(row: EventRow): void {
      pending.push(row);
    },
    onCommitted(observer: (rows: readonly EventRow[]) => void): void {
      observers.push(observer);
    },
  };
}
