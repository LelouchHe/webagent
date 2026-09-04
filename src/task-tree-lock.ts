export type TaskTreeLockMode = "shared" | "exclusive";

export interface TaskTreeLockSpec {
  /** Nodes that may be read while another operation mutates a disjoint branch. */
  shared?: readonly string[];
  /** Nodes whose subtree/child set is being structurally mutated. */
  exclusive?: readonly string[];
}

export type TaskTreeLockRelease = () => void;

type LockRequest = {
  shared: ReadonlySet<string>;
  exclusive: ReadonlySet<string>;
};

type PendingRequest = LockRequest & {
  resolve: (release: TaskTreeLockRelease) => void;
};

function normalize(spec: TaskTreeLockSpec): LockRequest {
  const exclusive = new Set(spec.exclusive ?? []);
  const shared = new Set(
    (spec.shared ?? []).filter((key) => !exclusive.has(key)),
  );
  return { shared, exclusive };
}

function conflicts(a: LockRequest, b: LockRequest): boolean {
  for (const key of a.exclusive) {
    if (b.exclusive.has(key) || b.shared.has(key)) return true;
  }
  for (const key of a.shared) {
    if (b.exclusive.has(key)) return true;
  }
  return false;
}

/**
 * Small in-process hierarchical lock scheduler for one task tree.
 *
 * Requests are granted atomically, so callers never hold part of a lineage
 * while waiting for another node. Compatible sibling requests can be active
 * together; an earlier conflicting request keeps later requests from
 * overtaking it. Releases are idempotent so failure paths can clean up safely.
 */
export class TaskTreeLock {
  private readonly active = new Set<LockRequest>();
  private readonly pending: PendingRequest[] = [];

  acquire(spec: TaskTreeLockSpec): Promise<TaskTreeLockRelease> {
    const request = normalize(spec);
    if (request.shared.size === 0 && request.exclusive.size === 0) {
      return Promise.resolve(() => {});
    }

    return new Promise<TaskTreeLockRelease>((resolve) => {
      this.pending.push({ ...request, resolve });
      this.pump();
    });
  }

  /** Acquire only when the scheduler is completely idle; otherwise skip. */
  tryAcquire(spec: TaskTreeLockSpec): TaskTreeLockRelease | null {
    if (this.active.size > 0 || this.pending.length > 0) return null;
    const request = normalize(spec);
    if (request.shared.size === 0 && request.exclusive.size === 0)
      return () => {};
    this.active.add(request);
    return this.releaseFor(request);
  }

  private pump(): void {
    for (let i = 0; i < this.pending.length; ) {
      const candidate = this.pending[i];
      const blockedByActive = [...this.active].some((active) =>
        conflicts(candidate, active),
      );
      const blockedByEarlier = this.pending
        .slice(0, i)
        .some((earlier) => conflicts(candidate, earlier));
      if (blockedByActive || blockedByEarlier) {
        i++;
        continue;
      }

      this.pending.splice(i, 1);
      this.active.add(candidate);
      candidate.resolve(this.releaseFor(candidate));
    }
  }

  private releaseFor(request: LockRequest): TaskTreeLockRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(request);
      this.pump();
    };
  }
}
