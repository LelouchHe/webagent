import type {
  CollaborationDeliveryRow,
  CollaborationMessageInput,
  CollaborationMessageRow,
} from "./store.ts";

export interface CollaborationMessageCreated {
  message: CollaborationMessageRow;
  delivery: CollaborationDeliveryRow;
}

/**
 * Storage seam for one collaboration message and its delivery. This is
 * deliberately narrower than the Store: it writes rows and runs transactions,
 * never reachability, projection, or obligation policy.
 */
export interface CollaborationMessageWriter {
  write(input: CollaborationMessageInput): CollaborationMessageCreated;
  transaction<T>(fn: () => T): T;
}

export type CollaborationMessageObserver = (
  created: CollaborationMessageCreated,
) => void;

/**
 * The single application boundary for creating a collaboration message and its
 * delivery.
 *
 * Both entry points register the same post-commit
 * `onCollaborationMessageCreated(message, delivery)` fact:
 *
 * - `create()` owns the transaction and flushes once it commits (the depth
 *   counter keeps nested creates from flushing early);
 * - `createInTransaction()` is for a caller that already owns a transaction
 *   (for example a Store method that must keep the message in the same atomic
 *   unit as its task update). It registers the fact and the caller invokes
 *   `afterCommit()` once its transaction commits.
 *
 * The raw Store insert is private to the Store; external callers reach
 * creation only through this emitter, so the observer cannot be bypassed by a
 * future creation path. The emitter itself decides nothing: reachability and
 * obligation policy belong to the observer.
 */
export class CollaborationMessageEmitter {
  private readonly writer: CollaborationMessageWriter;
  private readonly observers: CollaborationMessageObserver[] = [];
  private pending: CollaborationMessageCreated[] = [];
  private depth = 0;

  constructor(writer: CollaborationMessageWriter) {
    this.writer = writer;
  }

  onCreated(observer: CollaborationMessageObserver): void {
    this.observers.push(observer);
  }

  create(input: CollaborationMessageInput): CollaborationMessageCreated {
    this.depth += 1;
    try {
      return this.writer.transaction(() => {
        const created = this.writer.write(input);
        this.pending.push(created);
        return created;
      });
    } finally {
      this.depth -= 1;
      if (this.depth === 0) this.flush();
    }
  }

  /** Register a message created inside a caller-owned transaction. */
  createInTransaction(
    input: CollaborationMessageInput,
  ): CollaborationMessageCreated {
    const created = this.writer.write(input);
    this.pending.push(created);
    return created;
  }

  /** Emit pending facts; call after the caller-owned transaction commits. */
  afterCommit(): void {
    if (this.depth === 0) this.flush();
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = [];
    for (const created of pending) {
      for (const observer of this.observers) observer(created);
    }
  }
}
