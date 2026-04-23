/**
 * Per-session runtime state: single source of truth for "what state is this
 * session in right now" (busy / streaming / pending permissions).
 *
 * The frontend fetches a full snapshot on connect / reconnect / after long
 * backgrounding, then applies incremental `state_patch` SSE events. This
 * replaces the old "replay history + reconcile" approach which repeatedly
 * grew one-off sync paths per state field.
 */

export type BusyKind = "agent" | "bash";

export interface BusyState {
  kind: BusyKind;
  since: string;
  promptId: string | null;
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
}

export interface RuntimePatch {
  busy?: BusyState | null;
  pendingPermissions?: PendingPermission[];
  streaming?: Partial<StreamingState>;
}

export interface StatePatch {
  runtime?: RuntimePatch;
}

export interface SessionRuntimeState {
  seq: number;
  runtime: Runtime;
}

export interface StatePatchEvent {
  type: "state_patch";
  sessionId: string;
  seq: number;
  patch: StatePatch;
}

type Listener = (event: StatePatchEvent) => void;

function defaultState(): SessionRuntimeState {
  return {
    seq: 0,
    runtime: {
      busy: null,
      pendingPermissions: [],
      streaming: { assistant: false, thinking: false },
    },
  };
}

function busyEqual(a: BusyState | null, b: BusyState | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.since === b.since && a.promptId === b.promptId;
}

function permsEqual(a: PendingPermission[], b: PendingPermission[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (x.requestId !== y.requestId || x.toolName !== y.toolName || x.title !== y.title)
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

/** True when the patch would change the current runtime state. */
function hasRuntimeChanges(current: Runtime, patch: RuntimePatch | undefined): boolean {
  if (!patch) return false;
  if ("busy" in patch && !busyEqual(current.busy, patch.busy ?? null)) return true;
  if (
    "pendingPermissions" in patch &&
    patch.pendingPermissions &&
    !permsEqual(current.pendingPermissions, patch.pendingPermissions)
  )
    return true;
  if ("streaming" in patch && patch.streaming) {
    const s = patch.streaming;
    if (s.assistant !== undefined && s.assistant !== current.streaming.assistant) return true;
    if (s.thinking !== undefined && s.thinking !== current.streaming.thinking) return true;
  }
  return false;
}

export class SessionStateManager {
  private readonly states = new Map<string, SessionRuntimeState>();
  private readonly listeners = new Set<Listener>();
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Get current state (creates default entry on first access). */
  getState(sessionId: string): SessionRuntimeState {
    let s = this.states.get(sessionId);
    if (!s) {
      s = defaultState();
      this.states.set(sessionId, s);
    }
    return s;
  }

  /**
   * Merge a patch into the session's runtime state. Bumps seq and notifies
   * listeners only when the patch actually changes something (no-op patches
   * are dropped silently).
   */
  patch(sessionId: string, patch: StatePatch): void {
    const state = this.getState(sessionId);
    const runtimeChanged = hasRuntimeChanges(state.runtime, patch.runtime);
    if (!runtimeChanged) return;

    if (patch.runtime) {
      if ("busy" in patch.runtime) {
        state.runtime.busy = patch.runtime.busy ?? null;
      }
      if ("pendingPermissions" in patch.runtime && patch.runtime.pendingPermissions) {
        state.runtime.pendingPermissions = patch.runtime.pendingPermissions.slice();
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
      sessionId,
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

  /** Clear all state for a session (call from SessionManager.deleteSession). */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
    const t = this.cancelTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.cancelTimers.delete(sessionId);
    }
  }

  /**
   * Backend safety net for cancel: if busy is still set after `timeoutMs`,
   * force-clear it. Replaces the old frontend cancel timer.
   * A second arm on the same session replaces the existing timer.
   */
  armCancelSafety(sessionId: string, timeoutMs: number): void {
    if (timeoutMs <= 0) return;
    const existing = this.cancelTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.cancelTimers.delete(sessionId);
      this.patch(sessionId, { runtime: { busy: null } });
    }, timeoutMs);
    if (typeof t === "object" && "unref" in t) (t as { unref: () => void }).unref();
    this.cancelTimers.set(sessionId, t);
  }

  /** Cancel the safety net timer (e.g. when prompt_done arrives naturally). */
  clearCancelSafety(sessionId: string): void {
    const t = this.cancelTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.cancelTimers.delete(sessionId);
    }
  }
}
