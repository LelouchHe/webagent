import { ApiError, consumeMessage, getSession } from "./api.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import { handleEvent, loadHistory } from "./events.ts";
import { addSystem, scrollToBottom } from "./render.ts";
import {
  reloadSnapshot,
  requestNewSession,
  resetSessionUI,
  setHashSessionId,
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
  if (state.sessionId === sessionId) return "unchanged";

  state.sessionSwitchGen++;
  const generation = state.sessionSwitchGen;
  setHashSessionId(sessionId);
  resetSessionUI();
  state.sessionId = null;

  try {
    const [session, loaded] = await Promise.all([
      getSession(sessionId),
      loadHistory(sessionId),
    ]);
    if (generation !== state.sessionSwitchGen) return "ignored";
    await reloadSnapshot(sessionId);
    if (generation !== state.sessionSwitchGen) return "ignored";
    handleEvent({
      type: "session_created",
      sessionId: session.id,
      cwd: session.cwd,
      title: session.title,
      configOptions: session.configOptions,
    });
    if (loaded) scrollToBottom(true);
    return "switched";
  } catch (error) {
    if (generation === state.sessionSwitchGen) {
      resetSessionUI();
      state.sessionId = null;
    }
    throw error;
  }
}

export async function consumeAndSwitch(
  messageId: string,
): Promise<NavigationResult> {
  const result = await consumeMessage(messageId, state.sessionId);
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
      if (!state.sessionId) requestNewSession();
    }
    const message = error instanceof Error ? error.message : String(error);
    addSystem(`err: notification consume failed (${message})`);
    return terminal ? "terminal-error" : "retryable-error";
  }
}
