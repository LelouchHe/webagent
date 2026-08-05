import { state, resetSessionUI } from "./state.ts";
import { addSystem } from "./render.ts";
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
  addSystem(
    showCwd && nextCwd
      ? `Clearing session and starting at ${nextCwd}…`
      : "Clearing session…",
  );
  state.awaitingNewSession = true;
  try {
    await api.createSession({ cwd: nextCwd, inheritFromSessionId: oldId });
  } catch {
    state.awaitingNewSession = false;
    addSystem("err: Failed to clear session");
    return;
  }
  try {
    await api.deleteSession(oldId);
  } catch (err: unknown) {
    addSystem(`err: Failed to delete previous session — ${String(err)}`);
  }
}
