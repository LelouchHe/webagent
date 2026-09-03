import { state, resetSessionUI } from "./state.ts";
import { addSystem } from "./render.ts";
import { switchToSession } from "./session-navigation.ts";
import * as api from "./api.ts";

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
  resetSessionUI();
  state.sessionId = null;
  try {
    await api.clearSession(oldId, { cwd: nextCwd });
    // The clear response may race the broadcast used to refresh other clients.
    // Force this client through the normal history/runtime hydration path.
    state.sessionId = null;
    await switchToSession(oldId);
    addSystem(
      showCwd && nextCwd
        ? `Clearing session and starting at ${nextCwd}…`
        : "Clearing session…",
    );
  } catch (err: unknown) {
    state.sessionId = oldId;
    addSystem(`err: Failed to clear session — ${String(err)}`);
  }
}
