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
  scrollToBottom,
} from "./render.ts";
import type { AgentCommandSnapshot, ConfigOption } from "../../src/types.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import * as api from "./api.ts";
import { fallbackToNextTask } from "./events.ts";
import { setCurrentTask } from "./task-topology.ts";
import { taskAgentFailureLines } from "./create-command.ts";

interface ClearTaskResult {
  id: string;
  cwd: string;
  cwdDisplay?: string;
  title: string | null;
  configOptions: ConfigOption[];
  agentCommands?: AgentCommandSnapshot;
}

export async function exitCurrentTask(): Promise<void> {
  if (!state.taskId) {
    addSystem("warn: No active task");
    return;
  }
  if (state.busy) {
    addSystem("err: Cancel active work before exiting the task");
    return;
  }
  const exitId = state.taskId;
  // The delete does not answer until the agent is resolved and, on Root, a
  // replacement execution is warm — seconds during which the transcript would
  // otherwise stay unchanged and make the request look ignored. Force the
  // scroll: this row answers a user action, it is not streaming output the
  // reader may have scrolled away from.
  addSystem("notify: exiting the task tree");
  scrollToBottom(true);
  try {
    const result = await api.deleteTask(exitId);
    await fallbackToNextTask(
      exitId,
      state.taskCwd ?? undefined,
      result?.replacedBy ?? result?.parentId,
      result?.clientOpId,
      state.connectionEpoch,
      Boolean(result?.replacedBy),
    );
  } catch (err) {
    addSystem(`err: Failed to exit task — ${String(err)}`);
  }
}

/**
 * Detach the current task (and its subtree) from the tree without deleting it.
 * The task stays current and runnable; only its place in the tree changes, so
 * the local parent reference is settled immediately instead of waiting for the
 * next reload. The persisted system message arrives over SSE.
 */
export async function archiveCurrentTask(): Promise<void> {
  if (!state.taskId) {
    addSystem("warn: No active task");
    return;
  }
  const taskId = state.taskId;
  try {
    const result = await api.archiveTask(taskId);
    if (result.status === "already_archived") {
      addSystem("notify: this task is already archived");
      return;
    }
    setCurrentTask(taskId, { parentId: null, agentId: null });
    addSystem(
      `notify: archived — detached from ${result.parentPath ?? "its parent"}`,
    );
    if (result.pendingAccount) {
      addSystem(
        "notify: it still owed its original parent an account; after archiving, task_update is recorded but not delivered",
      );
    }
  } catch (err) {
    const e = err as api.ApiError;
    if (e.status === HTTP_STATUS.BAD_REQUEST) {
      addSystem("err: Root cannot be archived");
    } else if (e.status === HTTP_STATUS.NOT_FOUND) {
      addSystem("err: task not found");
    } else {
      addSystem("err: failed to archive task");
    }
  }
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
export async function compactCurrentTask(prompt?: string): Promise<void> {
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
    await api.compactTask(taskId, prompt);
  } catch (err: unknown) {
    addSystem(`err: Failed to compact task — ${String(err)}`);
  }
}

export async function replaceCurrentTask({
  cwd,
  showCwd = false,
  agentId = null,
}: {
  /** Omitted means "the directory this client currently believes in". */
  cwd?: string;
  showCwd?: boolean;
  agentId?: string | null;
} = {}): Promise<void> {
  if (!state.taskId) {
    addSystem("warn: No active task");
    return;
  }
  const oldId = state.taskId;
  const nextCwd = cwd ?? state.taskCwd ?? undefined;
  // Submission-time facts for a late failure: the view can move elsewhere
  // while the rotation is pending, and the rescue must not borrow the new
  // task's agent or directory.
  const failedAgentId = agentId ?? state.taskAgentId;
  const failedCwd = state.taskCwd;
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
      ...(nextCwd === undefined ? {} : { cwd: nextCwd }),
      agentId,
    })) as unknown as ClearTaskResult;
    resetClearedExecution();
    // Snapshot refresh is idempotent with the task_created broadcast, so
    // the client settles deterministically regardless of which arrives first.
    await hydrateTaskRuntime(oldId);
    applyClearResult(oldId, result);
  } catch (err: unknown) {
    for (const line of taskAgentFailureLines(
      "clear",
      err,
      failedAgentId,
      failedCwd,
    )) {
      addSystem(line);
    }
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
