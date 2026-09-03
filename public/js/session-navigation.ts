import { ApiError, consumeMessage, getSession } from "./api.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import { drainNavigationEvents, handleEvent, loadHistory } from "./events.ts";
import { addSystem, scrollToBottom } from "./render.ts";
import {
  hydrateSessionRuntime,
  finishNewSessionRequest,
  requestBootstrapSession,
  resetSessionUI,
  setHashSessionId,
  setTaskAnchor,
  state,
} from "./state.ts";

export type NavigationResult =
  | "switched"
  | "unchanged"
  | "ignored"
  | "retryable-error"
  | "terminal-error";

export interface NotificationTarget {
  sessionId?: string;
  messageId?: string;
}

const MESSAGE_QUERY_KEY = "message";
let attemptedStartupMessageId: string | null = null;

export async function switchToSession(
  sessionId: string,
): Promise<NavigationResult> {
  state.messageNavigationGen++;
  if (state.sessionId === sessionId) return "unchanged";
  state.sessionSwitchGen++;
  const generation = state.sessionSwitchGen;
  const previousSessionId = state.sessionId;
  const previousTaskId = state.taskId;
  finishNewSessionRequest();
  state.awaitingNewSession = false;
  state.pendingNavigationSessionId = null;
  state.pendingNavigationEvents = [];
  setHashSessionId(sessionId);
  resetSessionUI();
  state.sessionId = null;
  state.taskId = null;
  state.pendingNavigationSessionId = sessionId;
  const isCurrentNavigation = () =>
    generation === state.sessionSwitchGen &&
    state.pendingNavigationSessionId === sessionId;

  try {
    const [session, loaded] = await Promise.all([
      getSession(sessionId),
      loadHistory(sessionId),
    ]);
    if (!isCurrentNavigation()) return "ignored";
    // Anchor the URL on the owning Task (stable across clear).
    setTaskAnchor(session.task_id ?? null, session.id);
    const hydrated = await hydrateSessionRuntime(
      sessionId,
      isCurrentNavigation,
    );
    if (!hydrated) {
      if (!isCurrentNavigation()) return "ignored";
      throw new Error("Failed to hydrate session snapshot");
    }
    if (!isCurrentNavigation()) return "ignored";
    handleEvent({
      type: "session_created",
      sessionId: session.id,
      task_id: session.task_id ?? null,
      cwd: session.cwd,
      cwdDisplay: session.cwdDisplay,
      title: session.title,
      configOptions: session.configOptions,
    });
    drainNavigationEvents(sessionId);
    if (loaded) scrollToBottom(true);
    return "switched";
  } catch (error) {
    if (isCurrentNavigation()) {
      resetSessionUI();
      state.sessionId = null;
      if (previousSessionId) {
        setTaskAnchor(previousTaskId, previousSessionId);
      }
    }
    throw error;
  }
}

export async function consumeAndSwitch(
  messageId: string,
): Promise<NavigationResult> {
  const generation = ++state.messageNavigationGen;
  const result = await consumeMessage(messageId, state.sessionId);
  if (generation !== state.messageNavigationGen) return "ignored";
  addSystem(
    result.alreadyConsumed
      ? `inbox: already consumed → switching to ${result.sessionId}`
      : `inbox: opened as ${result.sessionId}`,
  );
  return switchToSession(result.sessionId);
}

export async function navigateFromNotification(
  target: NotificationTarget,
): Promise<NavigationResult> {
  if (target.sessionId) return switchToSession(target.sessionId);
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
      if (!state.sessionId) requestBootstrapSession();
    }
    const message = error instanceof Error ? error.message : String(error);
    addSystem(`err: notification consume failed (${message})`);
    return terminal ? "terminal-error" : "retryable-error";
  }
}
