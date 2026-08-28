import { state, sendCancel } from "./state.ts";
import { addSystem } from "./render.ts";

/** Cancel against server-authoritative state, even when the local busy flag is stale. */
export function requestAuthoritativeCancel(): void {
  if (!state.sessionId) {
    addSystem("Nothing to cancel.");
    return;
  }
  void sendCancel({ force: true })
    .then((result) => {
      addSystem(
        result?.status === "idle" ? "Nothing to cancel." : "^C cancelling…",
      );
    })
    .catch((err: unknown) => {
      addSystem(`err: cancel failed — ${String(err)}`);
    });
}
