import type { Store } from "./store.ts";

export interface DeletedRemoteChildRef {
  host: string;
  taskId: string;
}

export type RemoteTaskDeleteAttempt =
  | { kind: "deleted" }
  | {
      kind: "rejected";
      status: number;
      reason: string;
      code?: string;
      failedTaskId?: string;
    }
  | { kind: "unknown"; reason: string };

export type RemoteTaskDeleter = (
  host: string,
  taskId: string,
) => Promise<RemoteTaskDeleteAttempt>;

export class TaskRemoteDeleteError extends Error {
  readonly outcome: "rejected" | "unknown";
  readonly code: "remote_delete_rejected" | "remote_delete_unknown";
  readonly host: string;
  readonly failedTaskId: string;
  readonly remoteStatus: number | undefined;
  readonly deletedRemoteTasks: readonly DeletedRemoteChildRef[];

  constructor(input: {
    outcome: "rejected" | "unknown";
    host: string;
    failedTaskId: string;
    remoteStatus?: number;
    deletedRemoteTasks: readonly DeletedRemoteChildRef[];
    message: string;
  }) {
    super(input.message);
    this.name = "TaskRemoteDeleteError";
    this.outcome = input.outcome;
    this.code =
      input.outcome === "rejected"
        ? "remote_delete_rejected"
        : "remote_delete_unknown";
    this.host = input.host;
    this.failedTaskId = input.failedTaskId;
    this.remoteStatus = input.remoteStatus;
    this.deletedRemoteTasks = [...input.deletedRemoteTasks];
  }
}

export type TaskDeleteStateChangeCode =
  "edge_removed" | "new_remote_child" | "task_busy" | "target_changed";

export class TaskDeleteStateChangedError extends Error {
  readonly code: TaskDeleteStateChangeCode;
  readonly failedTaskId: string;
  readonly deletedRemoteTasks: readonly DeletedRemoteChildRef[];

  constructor(input: {
    code: TaskDeleteStateChangeCode;
    failedTaskId: string;
    deletedRemoteTasks: readonly DeletedRemoteChildRef[];
    message: string;
  }) {
    super(input.message);
    this.name = "TaskDeleteStateChangedError";
    this.code = input.code;
    this.failedTaskId = input.failedTaskId;
    this.deletedRemoteTasks = [...input.deletedRemoteTasks];
  }
}

export interface SynchronizedDeleteDeps<T> {
  store: Pick<
    Store,
    | "rootTaskId"
    | "getTask"
    | "getTaskPath"
    | "getDescendantTaskIds"
    | "listRemoteChildren"
    | "getRemoteChild"
    | "getExternalParentLink"
  >;
  targetId: string;
  expectRoot?: boolean;
  requiredExternalParentHost?: string;
  getBusyKind: (taskId: string) => "agent" | "bash" | null;
  isOwnCreationClaim?: (taskId: string) => boolean;
  preflightExtra?: () => Promise<void>;
  deleteRemote?: RemoteTaskDeleter;
  acquireLock: (taskId: string) => Promise<() => void>;
  createNotFoundError: (taskId: string) => Error;
  createBusyError: (taskId: string, path: string | undefined) => Error;
  commit: () => T;
}

export type DeleteFlowOptions<T> = Pick<
  SynchronizedDeleteDeps<T>,
  | "targetId"
  | "expectRoot"
  | "requiredExternalParentHost"
  | "preflightExtra"
  | "commit"
> & { ownCreationClaim?: boolean };

function remoteKey(host: string, taskId: string): string {
  return `${host}:${taskId}`;
}

function formatPartialSuffix(
  deleted: readonly DeletedRemoteChildRef[],
): string {
  if (deleted.length === 0) return "";
  const list = deleted.map((d) => `${d.taskId}@${d.host}`).join(", ");
  return ` Previously confirmed remote children are already gone: ${list}.`;
}

function subtreeIdsFor(
  store: Pick<Store, "getDescendantTaskIds">,
  rootId: string,
): string[] {
  return [rootId, ...store.getDescendantTaskIds(rootId)];
}

function remoteChildrenInSubtree(
  store: Pick<Store, "getDescendantTaskIds" | "listRemoteChildren">,
  rootId: string,
  knownSubtree?: readonly string[],
): Array<{
  local_task_id: string;
  remote_task_id: string;
  remote_host: string;
}> {
  const all = store.listRemoteChildren();
  if (all.length === 0) return [];
  const subtree = new Set(knownSubtree ?? subtreeIdsFor(store, rootId));
  return all.filter((child) => subtree.has(child.local_task_id));
}

function checkTargetAndEdge<T>(
  deps: SynchronizedDeleteDeps<T>,
  confirmed: readonly DeletedRemoteChildRef[],
): void {
  const { store, targetId, expectRoot, requiredExternalParentHost } = deps;
  const targetLive =
    store.getTask(targetId) !== undefined &&
    (!expectRoot || store.rootTaskId === targetId);
  if (!targetLive) {
    if (confirmed.length > 0) {
      throw new TaskDeleteStateChangedError({
        code: "target_changed",
        failedTaskId: targetId,
        deletedRemoteTasks: confirmed,
        message: `Target task ${targetId} was already removed or replaced during deletion.${formatPartialSuffix(confirmed)}`,
      });
    }
    throw deps.createNotFoundError(targetId);
  }
  if (
    requiredExternalParentHost !== undefined &&
    store.getExternalParentLink(targetId)?.remote_host !==
      requiredExternalParentHost
  ) {
    if (confirmed.length > 0) {
      throw new TaskDeleteStateChangedError({
        code: "edge_removed",
        failedTaskId: targetId,
        deletedRemoteTasks: confirmed,
        message: `Target task ${targetId} was preserved because its external parent link on ${requiredExternalParentHost} is no longer active.${formatPartialSuffix(confirmed)}`,
      });
    }
    throw deps.createNotFoundError(targetId);
  }
}

function findBusyInSubtree<T>(
  deps: SynchronizedDeleteDeps<T>,
  subtreeIds: readonly string[],
): string | undefined {
  return subtreeIds.find((id) => {
    const busy = deps.getBusyKind(id);
    if (busy === null) return false;
    return !(
      id === deps.targetId &&
      busy === "agent" &&
      deps.isOwnCreationClaim?.(id) === true
    );
  });
}

export async function runSynchronizedDelete<T>(
  deps: SynchronizedDeleteDeps<T>,
): Promise<T> {
  const { store, targetId } = deps;
  const confirmed = new Map<string, DeletedRemoteChildRef>();
  const confirmedList = (): DeletedRemoteChildRef[] => [...confirmed.values()];

  // 1. Local preflight before any remote call (no lock or transaction held).
  const initialCandidates = deps.deleteRemote
    ? remoteChildrenInSubtree(store, targetId)
    : [];
  if (initialCandidates.length > 0) {
    checkTargetAndEdge(deps, []);
    const preflightBusy = findBusyInSubtree(
      deps,
      subtreeIdsFor(store, targetId),
    );
    if (preflightBusy) {
      throw deps.createBusyError(
        preflightBusy,
        store.getTaskPath(preflightBusy),
      );
    }
  }
  if (deps.preflightExtra) {
    await deps.preflightExtra();
  }

  // 2. Synchronous children-first remote delete loop (no lock held).
  for (const candidate of initialCandidates) {
    const key = remoteKey(candidate.remote_host, candidate.remote_task_id);
    if (confirmed.has(key)) continue;

    checkTargetAndEdge(deps, confirmedList());
    const liveSubtree = new Set(subtreeIdsFor(store, targetId));
    const currentEdge = store.getRemoteChild(
      candidate.remote_host,
      candidate.remote_task_id,
    );
    if (
      currentEdge?.local_task_id !== candidate.local_task_id ||
      !liveSubtree.has(candidate.local_task_id)
    ) {
      continue;
    }

    const attempt: RemoteTaskDeleteAttempt = deps.deleteRemote
      ? await deps.deleteRemote(candidate.remote_host, candidate.remote_task_id)
      : {
          kind: "unknown",
          reason: "Remote host transport is not configured",
        };
    if (attempt.kind === "deleted") {
      confirmed.set(key, {
        host: candidate.remote_host,
        taskId: candidate.remote_task_id,
      });
      continue;
    }
    const deleted = confirmedList();
    if (attempt.kind === "rejected") {
      throw new TaskRemoteDeleteError({
        outcome: "rejected",
        host: candidate.remote_host,
        failedTaskId: candidate.remote_task_id,
        remoteStatus: attempt.status,
        deletedRemoteTasks: deleted,
        message: `Target task ${targetId} was preserved because deleting remote child ${candidate.remote_task_id} on ${candidate.remote_host} failed: ${attempt.reason}.${formatPartialSuffix(deleted)}`,
      });
    }
    throw new TaskRemoteDeleteError({
      outcome: "unknown",
      host: candidate.remote_host,
      failedTaskId: candidate.remote_task_id,
      deletedRemoteTasks: deleted,
      message: `Target task ${targetId} was preserved because deleting remote child ${candidate.remote_task_id} on ${candidate.remote_host} had an unknown result (${attempt.reason}); that remote child may already have changed.${formatPartialSuffix(deleted)}`,
    });
  }

  // 3. Final recheck and commit inside tree mutation lock (no awaits).
  const release = await deps.acquireLock(targetId);
  try {
    const deleted = confirmedList();
    checkTargetAndEdge(deps, deleted);
    const finalSubtree = subtreeIdsFor(store, targetId);
    const finalBusy = findBusyInSubtree(deps, finalSubtree);
    if (finalBusy) {
      if (deleted.length > 0) {
        const busyPath = store.getTaskPath(finalBusy) ?? finalBusy;
        throw new TaskDeleteStateChangedError({
          code: "task_busy",
          failedTaskId: finalBusy,
          deletedRemoteTasks: deleted,
          message: `Target task ${targetId} was preserved because ${busyPath} became busy during deletion.${formatPartialSuffix(deleted)}`,
        });
      }
      throw deps.createBusyError(finalBusy, store.getTaskPath(finalBusy));
    }
    const unhandled = remoteChildrenInSubtree(
      store,
      targetId,
      finalSubtree,
    ).find(
      (child) =>
        !confirmed.has(remoteKey(child.remote_host, child.remote_task_id)),
    );
    if (unhandled) {
      throw new TaskDeleteStateChangedError({
        code: "new_remote_child",
        failedTaskId: unhandled.remote_task_id,
        deletedRemoteTasks: deleted,
        message: `Target task ${targetId} was preserved because remote child ${unhandled.remote_task_id} on ${unhandled.remote_host} appeared during deletion.${formatPartialSuffix(deleted)}`,
      });
    }
    return deps.commit();
  } finally {
    release();
  }
}
