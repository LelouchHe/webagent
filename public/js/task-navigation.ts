import { ApiError, consumeMessage, getTask } from "./api.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import { drainNavigationEvents, handleEvent, loadHistory } from "./events.ts";
import { addSystem, scrollToBottom } from "./render.ts";
import {
  hydrateTaskRuntime,
  finishNewTaskRequest,
  requestBootstrapTask,
  resetTaskUI,
  setHashTaskId,
  state,
} from "./state.ts";

export type NavigationResult =
  | "switched"
  | "unchanged"
  | "ignored"
  | "retryable-error"
  | "terminal-error";

export interface NotificationTarget {
  taskId?: string;
  messageId?: string;
}

const MESSAGE_QUERY_KEY = "message";
let attemptedStartupMessageId: string | null = null;

export async function switchToTask(taskId: string): Promise<NavigationResult> {
  state.messageNavigationGen++;
  if (state.taskId === taskId) return "unchanged";
  state.taskSwitchGen++;
  const generation = state.taskSwitchGen;
  const previousTaskId = state.taskId;
  finishNewTaskRequest();
  state.awaitingNewTask = false;
  state.pendingNavigationTaskId = null;
  state.pendingNavigationEvents = [];
  setHashTaskId(taskId);
  resetTaskUI();
  state.taskId = null;
  state.pendingNavigationTaskId = taskId;
  const isCurrentNavigation = () =>
    generation === state.taskSwitchGen &&
    state.pendingNavigationTaskId === taskId;

  try {
    const [task, loaded] = await Promise.all([
      getTask(taskId),
      loadHistory(taskId),
    ]);
    if (!isCurrentNavigation()) return "ignored";
    const hydrated = await hydrateTaskRuntime(taskId, isCurrentNavigation);
    if (!hydrated) {
      if (!isCurrentNavigation()) return "ignored";
      throw new Error("Failed to hydrate task snapshot");
    }
    if (!isCurrentNavigation()) return "ignored";
    handleEvent({
      type: "task_created",
      taskId: task.id,
      cwd: task.cwd,
      cwdDisplay: task.cwdDisplay,
      title: task.title,
      configOptions: task.configOptions,
    });
    drainNavigationEvents(taskId);
    if (loaded) scrollToBottom(true);
    return "switched";
  } catch (error) {
    if (isCurrentNavigation()) {
      resetTaskUI();
      state.taskId = null;
      if (previousTaskId) setHashTaskId(previousTaskId);
    }
    throw error;
  }
}

export async function consumeAndSwitch(
  messageId: string,
): Promise<NavigationResult> {
  const generation = ++state.messageNavigationGen;
  const result = await consumeMessage(messageId, state.taskId);
  if (generation !== state.messageNavigationGen) return "ignored";
  addSystem(
    result.alreadyConsumed
      ? `inbox: already consumed → switching to ${result.taskId}`
      : `inbox: opened as ${result.taskId}`,
  );
  return switchToTask(result.taskId);
}

export async function navigateFromNotification(
  target: NotificationTarget,
): Promise<NavigationResult> {
  if (target.taskId) return switchToTask(target.taskId);
  if (target.messageId) return consumeAndSwitch(target.messageId);
  return "ignored";
}

export function getStartupMessageIntent(): string | null {
  const value = new URL(location.href).searchParams.get(MESSAGE_QUERY_KEY);
  return value && value.length <= 256 ? value : null;
}

function clearStartupMessageIntent(): void {
  const url = new URL(location.href);
  url.searchParams.delete(MESSAGE_QUERY_KEY);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export async function processStartupMessageIntent(): Promise<NavigationResult> {
  const messageId = getStartupMessageIntent();
  if (!messageId || attemptedStartupMessageId === messageId) return "ignored";
  attemptedStartupMessageId = messageId;

  try {
    const result = await consumeAndSwitch(messageId);
    clearStartupMessageIntent();
    return result;
  } catch (error) {
    const terminal =
      error instanceof ApiError &&
      (error.status === HTTP_STATUS.BAD_REQUEST ||
        error.status === HTTP_STATUS.NOT_FOUND);
    if (terminal) {
      clearStartupMessageIntent();
      if (!state.taskId) requestBootstrapTask();
    }
    const message = error instanceof Error ? error.message : String(error);
    addSystem(`err: notification consume failed (${message})`);
    return terminal ? "terminal-error" : "retryable-error";
  }
}
