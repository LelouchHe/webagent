/**
 * Per-task runtime state: single source of truth for "what state is this
 * task in right now" (busy / streaming / pending permissions / plan).
 *
 * The frontend fetches a full snapshot on connect / reconnect / after long
 * backgrounding, then applies incremental `state_patch` SSE events. This
 * replaces the old "replay history + reconcile" approach which repeatedly
 * grew one-off sync paths per state field.
 */

import type { ContextUsage, PlanEntry } from "./types.ts";
import { log } from "./log.ts";

const clog = log.scope("cancel");

export type BusyKind = "agent" | "bash";
export type CancelStatus = "requested" | "unconfirmed";

export interface BusyState {
  kind: BusyKind;
  since: string;
  promptId: string | null;
  cancelStatus?: CancelStatus | null;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  title: string;
  options: Array<{ optionId: string; label: string }>;
}

export interface StreamingState {
  assistant: boolean;
  thinking: boolean;
}

export interface Runtime {
  busy: BusyState | null;
  pendingPermissions: PendingPermission[];
  streaming: StreamingState;
  plan: PlanEntry[] | null;
  contextUsage: ContextUsage | null;
}

export interface RuntimePatch {
  busy?: BusyState | null;
  pendingPermissions?: PendingPermission[];
  streaming?: Partial<StreamingState>;
  plan?: PlanEntry[] | null;
  contextUsage?: ContextUsage | null;
}

export interface StatePatch {
  runtime?: RuntimePatch;
}

export interface TaskRuntimeState {
  seq: number;
  runtime: Runtime;
}

export interface StatePatchEvent {
  type: "state_patch";
  taskId: string;
  seq: number;
  patch: StatePatch;
}

type Listener = (event: StatePatchEvent) => void;

function defaultState(): TaskRuntimeState {
  return {
    seq: 0,
    runtime: {
      busy: null,
      pendingPermissions: [],
      streaming: { assistant: false, thinking: false },
      plan: null,
      contextUsage: null,
    },
  };
}

function busyEqual(a: BusyState | null, b: BusyState | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.kind === b.kind &&
    a.since === b.since &&
    a.promptId === b.promptId &&
    (a.cancelStatus ?? null) === (b.cancelStatus ?? null)
  );
}

function permsEqual(a: PendingPermission[], b: PendingPermission[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (
      x.requestId !== y.requestId ||
      x.toolName !== y.toolName ||
      x.title !== y.title
    )
      return false;
    if (x.options.length !== y.options.length) return false;
    for (let j = 0; j < x.options.length; j++) {
      if (
        x.options[j].optionId !== y.options[j].optionId ||
        x.options[j].label !== y.options[j].label
      )
        return false;
    }
  }
  return true;
}

function plansEqual(a: PlanEntry[] | null, b: PlanEntry[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.status === b[index].status && entry.content === b[index].content,
  );
}

function contextUsageEqual(
  a: ContextUsage | null,
  b: ContextUsage | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.used === b.used &&
    a.size === b.size &&
    (a.cost?.amount ?? null) === (b.cost?.amount ?? null) &&
    (a.cost?.currency ?? null) === (b.cost?.currency ?? null)
  );
}

/** True when the patch would change the current runtime state. */
function hasRuntimeChanges(
  current: Runtime,
  patch: RuntimePatch | undefined,
): boolean {
  if (!patch) return false;
  if ("busy" in patch && !busyEqual(current.busy, patch.busy ?? null))
    return true;
  if (
    "pendingPermissions" in patch &&
    patch.pendingPermissions &&
    !permsEqual(current.pendingPermissions, patch.pendingPermissions)
  )
    return true;
  if ("plan" in patch && !plansEqual(current.plan, patch.plan ?? null))
    return true;
  if (
    "contextUsage" in patch &&
    !contextUsageEqual(current.contextUsage, patch.contextUsage ?? null)
  )
    return true;
  if ("streaming" in patch && patch.streaming) {
    const s = patch.streaming;
    if (
      s.assistant !== undefined &&
      s.assistant !== current.streaming.assistant
    )
      return true;
    if (s.thinking !== undefined && s.thinking !== current.streaming.thinking)
      return true;
  }
  return false;
}

export class TaskStateManager {
  private readonly states = new Map<string, TaskRuntimeState>();
  private readonly listeners = new Set<Listener>();
  private readonly cancelTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /** Get current state (creates default entry on first access). */
  getState(taskId: string): TaskRuntimeState {
    let s = this.states.get(taskId);
    if (!s) {
      s = defaultState();
      this.states.set(taskId, s);
    }
    return s;
  }

  /** Read streaming state without creating runtime state for an unseen task. */
  peekStreaming(taskId: string): StreamingState {
    const streaming = this.states.get(taskId)?.runtime.streaming;
    return streaming ? { ...streaming } : { assistant: false, thinking: false };
  }

  /**
   * Merge a patch into the task's runtime state. Bumps seq and notifies
   * listeners only when the patch actually changes something (no-op patches
   * are dropped silently).
   */
  patch(taskId: string, patch: StatePatch): void {
    const state = this.getState(taskId);
    const runtimeChanged = hasRuntimeChanges(state.runtime, patch.runtime);
    if (!runtimeChanged) return;

    if (patch.runtime) {
      if ("busy" in patch.runtime) {
        state.runtime.busy = patch.runtime.busy ?? null;
      }
      if (
        "pendingPermissions" in patch.runtime &&
        patch.runtime.pendingPermissions
      ) {
        state.runtime.pendingPermissions =
          patch.runtime.pendingPermissions.slice();
      }
      if ("plan" in patch.runtime) {
        state.runtime.plan =
          patch.runtime.plan?.map((entry) => ({ ...entry })) ?? null;
      }
      if ("contextUsage" in patch.runtime) {
        const usage = patch.runtime.contextUsage;
        state.runtime.contextUsage = usage
          ? {
              ...usage,
              ...(usage.cost ? { cost: { ...usage.cost } } : {}),
            }
          : null;
      }
      if ("streaming" in patch.runtime && patch.runtime.streaming) {
        if (patch.runtime.streaming.assistant !== undefined) {
          state.runtime.streaming.assistant = patch.runtime.streaming.assistant;
        }
        if (patch.runtime.streaming.thinking !== undefined) {
          state.runtime.streaming.thinking = patch.runtime.streaming.thinking;
        }
      }
    }
    state.seq += 1;

    const event: StatePatchEvent = {
      type: "state_patch",
      taskId,
      seq: state.seq,
      patch,
    };
    for (const l of this.listeners) l(event);
  }

  /** Subscribe to patch events. Returns an unsubscribe function. */
  onPatch(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Clear all state for a task (call from TaskManager.deleteTask). */
  delete(taskId: string): void {
    this.states.delete(taskId);
    const t = this.cancelTimers.get(taskId);
    if (t) {
      clearTimeout(t);
      this.cancelTimers.delete(taskId);
    }
  }

  /**
   * Reset a live task's runtime state to defaults without restarting the
   * seq ledger. Used when rotating a task's ACP execution in place (clear):
   * the WebAgent task identity survives, so clients that validate
   * incremental `state_patch` events against their own lastStateSeq must keep
   * seeing a monotonic seq. Hard-deleting the entry here would restart the
   * server seq at 0; every post-rotation snapshot would then look
   * "superseded" to the client and be dropped, leaving it permanently
   * desynced (stuck busy). Broadcasts one patch when anything actually
   * changed, mirroring the explicit reset patch used by the compaction path.
   */
  reset(taskId: string): void {
    this.clearCancelSafety(taskId);
    this.patch(taskId, {
      runtime: {
        busy: null,
        pendingPermissions: [],
        streaming: { assistant: false, thinking: false },
        plan: null,
        contextUsage: null,
      },
    });
  }

  /** Clear current plans for every known task (used on bridge reload). */
  clearPlans(): void {
    for (const [taskId, state] of this.states) {
      if (state.runtime.plan !== null) {
        this.patch(taskId, { runtime: { plan: null } });
      }
    }
  }

  /** Clear context usage for every known task on bridge teardown. */
  clearContextUsage(): void {
    for (const [taskId, state] of this.states) {
      if (state.runtime.contextUsage !== null) {
        this.patch(taskId, { runtime: { contextUsage: null } });
      }
    }
  }

  /** Clear active stream markers for every known task on bridge teardown. */
  clearStreaming(): void {
    for (const [taskId, state] of this.states) {
      if (
        state.runtime.streaming.assistant ||
        state.runtime.streaming.thinking
      ) {
        this.patch(taskId, {
          runtime: {
            streaming: { assistant: false, thinking: false },
          },
        });
      }
    }
  }

  /**
   * Backend acknowledgement timer for cancel: if the same agent prompt is
   * still pending after `timeoutMs`, mark the request unconfirmed.
   * A second arm on the same task replaces the existing timer.
   */
  armCancelSafety(taskId: string, timeoutMs: number): void {
    if (timeoutMs <= 0) return;
    const existing = this.cancelTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.cancelTimers.delete(taskId);
      const busy = this.getState(taskId).runtime.busy;
      if (busy?.kind === "agent" && busy.cancelStatus === "requested") {
        clog.warn("agent did not acknowledge", {
          taskId: taskId.slice(0, 8),
          promptId: busy.promptId,
        });
        this.patch(taskId, {
          runtime: {
            busy: { ...busy, cancelStatus: "unconfirmed" },
          },
        });
      }
    }, timeoutMs);
    if (typeof t === "object" && "unref" in t)
      (t as { unref: () => void }).unref();
    this.cancelTimers.set(taskId, t);
  }

  /** Mark that a cancel notification was sent for the active agent prompt. */
  markCancelRequested(taskId: string): void {
    const busy = this.getState(taskId).runtime.busy;
    if (busy?.kind !== "agent") return;
    this.patch(taskId, {
      runtime: { busy: { ...busy, cancelStatus: "requested" } },
    });
  }

  /** Cancel the safety net timer (e.g. when prompt_done arrives naturally). */
  clearCancelSafety(taskId: string): void {
    const t = this.cancelTimers.get(taskId);
    if (t) {
      clearTimeout(t);
      this.cancelTimers.delete(taskId);
    }
  }
}
