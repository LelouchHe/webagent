import {
  applyAgentCommandSnapshot,
  clearCancelTimer,
  hydrateTaskRuntime,
  state,
  updateConfigOptions,
  updateTaskInfo,
} from "./state.ts";
import {
  addSystem,
  finishAssistant,
  finishBash,
  finishThinking,
} from "./render.ts";
import type { AgentCommandSnapshot, ConfigOption } from "../../src/types.ts";
import * as api from "./api.ts";

interface ClearTaskResult {
  id: string;
  cwd: string;
  cwdDisplay?: string;
  title: string | null;
  configOptions: ConfigOption[];
  agentCommands?: AgentCommandSnapshot;
}

/**
 * Rotate the task's ACP execution in place. The stable WebAgent task
 * identity and its history are unchanged by clear, so the message DOM and the
 * SSE cursors stay intact; only the runtime state that belonged to the retired
 * execution is reset, and busy/plan/commands/config are repainted from the
 * post-rotation snapshot.
 *
 * state.taskId deliberately stays set during the request: the server
 * broadcasts task_created before responding, and with the id set that
 * broadcast takes the normal same-task branch (config repaint) instead of
 * the activation path that a null id would trigger.
 */
export async function compactCurrentTask(): Promise<void> {
  if (!state.taskId) {
    addSystem("warn: No active task");
    return;
  }
  if (state.busy) {
    addSystem("err: Cancel active work before compacting the task");
    return;
  }
  const taskId = state.taskId;
  addSystem("Compacting context…");
  try {
    await api.compactTask(taskId);
  } catch (err: unknown) {
    addSystem(`err: Failed to compact task — ${String(err)}`);
  }
}

export async function replaceCurrentTask({
  cwd,
  showCwd = false,
}: {
  cwd?: string;
  showCwd?: boolean;
} = {}): Promise<void> {
  if (!state.taskId) {
    addSystem("warn: No active task");
    return;
  }
  const oldId = state.taskId;
  const nextCwd = cwd ?? state.taskCwd ?? undefined;
  if (state.busy) {
    addSystem("err: Cancel active work before clearing the task");
    return;
  }
  addSystem(
    showCwd && nextCwd
      ? `Clearing task and starting at ${nextCwd}…`
      : "Clearing task…",
  );
  try {
    const result = (await api.clearTask(oldId, {
      cwd: nextCwd,
    })) as unknown as ClearTaskResult;
    resetClearedExecution();
    // Snapshot refresh is idempotent with the task_created broadcast, so
    // the client settles deterministically regardless of which arrives first.
    await hydrateTaskRuntime(oldId);
    applyClearResult(oldId, result);
  } catch (err: unknown) {
    addSystem(`err: Failed to clear task — ${String(err)}`);
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
function applyClearResult(taskId: string, result: ClearTaskResult): void {
  updateConfigOptions(result.configOptions);
  if (result.agentCommands) applyAgentCommandSnapshot(result.agentCommands);
  state.taskCwd = result.cwd;
  state.taskCwdDisplay = result.cwdDisplay ?? result.cwd;
  state.taskTitle = result.title;
  updateTaskInfo(taskId, state.taskTitle);
}
