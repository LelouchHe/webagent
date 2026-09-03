import {
  applyAgentCommandSnapshot,
  clearCancelTimer,
  hydrateSessionRuntime,
  state,
  updateConfigOptions,
  updateSessionInfo,
} from "./state.ts";
import {
  addSystem,
  finishAssistant,
  finishBash,
  finishThinking,
} from "./render.ts";
import type { AgentCommandSnapshot, ConfigOption } from "../../src/types.ts";
import * as api from "./api.ts";

interface ClearSessionResult {
  id: string;
  cwd: string;
  cwdDisplay?: string;
  title: string | null;
  configOptions: ConfigOption[];
  agentCommands?: AgentCommandSnapshot;
}

/**
 * Rotate the session's ACP execution in place. The stable WebAgent session
 * identity and its history are unchanged by clear, so the message DOM and the
 * SSE cursors stay intact; only the runtime state that belonged to the retired
 * execution is reset, and busy/plan/commands/config are repainted from the
 * post-rotation snapshot.
 *
 * state.sessionId deliberately stays set during the request: the server
 * broadcasts session_created before responding, and with the id set that
 * broadcast takes the normal same-session branch (config repaint) instead of
 * the activation path that a null id would trigger.
 */
export async function compactCurrentSession(): Promise<void> {
  if (!state.sessionId) {
    addSystem("warn: No active session");
    return;
  }
  if (state.busy) {
    addSystem("err: Cancel active work before compacting the session");
    return;
  }
  const sessionId = state.sessionId;
  addSystem("Compacting context…");
  try {
    await api.compactSession(sessionId);
  } catch (err: unknown) {
    addSystem(`err: Failed to compact session — ${String(err)}`);
  }
}

export async function replaceCurrentSession({
  cwd,
  showCwd = false,
}: {
  cwd?: string;
  showCwd?: boolean;
} = {}): Promise<void> {
  if (!state.sessionId) {
    addSystem("warn: No active session");
    return;
  }
  const oldId = state.sessionId;
  const nextCwd = cwd ?? state.sessionCwd ?? undefined;
  if (state.busy) {
    addSystem("err: Cancel active work before clearing the session");
    return;
  }
  addSystem(
    showCwd && nextCwd
      ? `Clearing session and starting at ${nextCwd}…`
      : "Clearing session…",
  );
  try {
    const result = (await api.clearSession(oldId, {
      cwd: nextCwd,
    })) as unknown as ClearSessionResult;
    resetClearedExecution();
    // Snapshot refresh is idempotent with the session_created broadcast, so
    // the client settles deterministically regardless of which arrives first.
    await hydrateSessionRuntime(oldId);
    applyClearResult(oldId, result);
  } catch (err: unknown) {
    addSystem(`err: Failed to clear session — ${String(err)}`);
  }
}

/**
 * Drop client state that was scoped to the retired ACP execution, mirroring
 * the server-side runtime reset without touching the conversation DOM, which
 * is byte-identical before and after clear.
 */
function resetClearedExecution(): void {
  finishThinking();
  finishAssistant();
  if (state.currentBashEl)
    finishBash(state.currentBashEl, null, "disconnected");
  state.busyKind = null;
  state.cancelStatus = null;
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
  state.pendingPromptDone = false;
  state.turnEnded = false;
  state.currentPromptId = null;
  state.newTurnStarted = false;
  state.sentMessageOpId = null;
  state.awaitingOwnUserEcho = false;
  clearCancelTimer();
}

/** Apply the clear response deterministically (no-op when the broadcast or
 * snapshot already applied the same values). */
function applyClearResult(sessionId: string, result: ClearSessionResult): void {
  updateConfigOptions(result.configOptions);
  if (result.agentCommands) applyAgentCommandSnapshot(result.agentCommands);
  state.sessionCwd = result.cwd;
  state.sessionCwdDisplay = result.cwdDisplay ?? result.cwd;
  state.sessionTitle = result.title;
  updateSessionInfo(sessionId, state.sessionTitle);
}
