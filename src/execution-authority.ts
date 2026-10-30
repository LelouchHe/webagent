/**
 * Execution authority: the process-local bookkeeping that decides which
 * execution may still write to a task.
 *
 * Three facts live here and nowhere else:
 *
 * - **binding** — which `(agentId, sessionId)` currently executes a task. The
 *   Store owns the row; this module owns the *facts* about it after the
 *   outermost commit that changed it.
 * - **generation** — an integer per task: "I accept writes from generation N
 *   only". It is a property of the task, not of an execution or an agent, and
 *   it is deliberately **not persisted**: a restart kills every execution, so
 *   there is no previous generation whose late writes could arrive.
 * - **lease** — `{taskId, generation}` captured when an operation starts and
 *   validated at the two write boundaries (event entry, synchronous commit).
 *   A missing lease or an unknown generation is refused; it is never
 *   auto-filled with the current value.
 *
 * The only thing that advances a generation is a committed binding change, so
 * a rotation cannot be half-applied: the batch is either committed (and bumps
 * once per changed task) or discarded.
 */

/** The execution bound to a task: the ACP agent plus its session. */
export interface ExecutionBinding {
  readonly agentId: string;
  readonly sessionId: string;
}

/**
 * One task's binding before/after one outermost commit. `before` and `after`
 * are full bindings, so `null` means "no binding" (detached or deleted).
 */
export interface BindingChange {
  readonly taskId: string;
  readonly before: ExecutionBinding | null;
  readonly after: ExecutionBinding | null;
}

/** A captured right to write to a task at a specific generation. */
export interface ExecutionLease {
  readonly taskId: string;
  readonly generation: number;
}

/**
 * What a bridge needs in order to gate execution-scoped events: the current
 * lease for a task, and the verdict on a captured one.
 */
export interface ExecutionLeaseSource {
  /** Current lease for a task, or null when the task has no ledger entry. */
  leaseFor(taskId: string): ExecutionLease | null;
  /** True only for a lease naming the task's current generation. */
  accepts(lease: ExecutionLease): boolean;
}

/**
 * Read the lease an agent event was stamped with. The stamp is read through a
 * helper (rather than declared on every event variant) so the transport type
 * stays untouched while the value is still validated at the boundary.
 */
export function leaseOf(event: object): ExecutionLease | undefined {
  const raw = (event as { executionLease?: unknown }).executionLease;
  if (!raw || typeof raw !== "object") return undefined;
  const { taskId, generation } = raw as {
    taskId?: unknown;
    generation?: unknown;
  };
  if (typeof taskId !== "string" || typeof generation !== "number") {
    return undefined;
  }
  return { taskId, generation };
}

export function bindingsEqual(
  a: ExecutionBinding | null,
  b: ExecutionBinding | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.agentId === b.agentId && a.sessionId === b.sessionId;
}

export function formatBinding(binding: ExecutionBinding | null): string {
  return binding === null ? "none" : `${binding.agentId}:${binding.sessionId}`;
}

/**
 * Per-task generation ledger. Entries are created when a task becomes live in
 * this process and dropped when it is deleted, so the map cannot accumulate
 * entries for tasks that no longer exist.
 */
export class GenerationLedger {
  private readonly generations = new Map<string, number>();

  generationOf(taskId: string): number | undefined {
    return this.generations.get(taskId);
  }

  /** Advance a task's generation, creating the entry when absent. */
  bump(taskId: string): number {
    const next = (this.generations.get(taskId) ?? 0) + 1;
    this.generations.set(taskId, next);
    return next;
  }

  clear(taskId: string): void {
    this.generations.delete(taskId);
  }

  has(taskId: string): boolean {
    return this.generations.has(taskId);
  }

  get size(): number {
    return this.generations.size;
  }
}

/**
 * The single write authority for execution-scoped facts. A Store binding
 * write reports its changes here after the outermost commit; a rotated task's
 * generation advances exactly once per commit, never once per SQL statement.
 */
export class ExecutionAuthority {
  private readonly ledger: GenerationLedger;

  constructor(ledger: GenerationLedger) {
    this.ledger = ledger;
  }

  generationOf(taskId: string): number | undefined {
    return this.ledger.generationOf(taskId);
  }

  /**
   * Current lease for a task, or `null` when the task has no ledger entry.
   * Callers capture this at operation start; they must not re-read it later
   * and treat that as validation.
   */
  leaseFor(taskId: string): ExecutionLease | null {
    const generation = this.ledger.generationOf(taskId);
    return generation === undefined ? null : { taskId, generation };
  }

  /**
   * Give a task a ledger entry when a lifecycle path makes it live without a
   * binding *change*. The one real case is a restore after a restart: the
   * stored binding is unchanged, but this process has no generation for it yet
   * because generations are not persisted. Never use this to paper over a
   * missing lease on a write path.
   */
  adopt(taskId: string): ExecutionLease {
    if (!this.ledger.has(taskId)) {
      this.ledger.bump(taskId);
    }
    return this.leaseFor(taskId)!;
  }

  /**
   * Apply the committed facts of one outermost transaction. A detach (or a
   * hard delete, reported as before→null) drops the entry so a late write can
   * never revive it; any other change bumps the generation.
   */
  applyBindingChanges(changes: readonly BindingChange[]): void {
    for (const change of changes) {
      if (bindingsEqual(change.before, change.after)) continue;
      if (change.after === null) {
        this.ledger.clear(change.taskId);
      } else {
        this.ledger.bump(change.taskId);
      }
    }
  }

  /** True only for a lease naming the task's current generation. */
  accepts(lease: ExecutionLease | null | undefined): boolean {
    if (!lease) return false;
    return this.ledger.generationOf(lease.taskId) === lease.generation;
  }

  /** Drop a deleted task's entry so the table cannot accumulate stale ids. */
  clear(taskId: string): void {
    this.ledger.clear(taskId);
  }
}
