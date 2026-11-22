import type { Store } from "./store.ts";
import type { ObligationController } from "./obligation-controller.ts";

export interface AgentUpdatePersistenceResult {
  collaborationMessageId: string | null;
  accountTargetTaskId: string | null;
  silenceWatchMs?: number;
}

export function persistAgentUpdate(
  store: Store,
  obligations: Pick<
    ObligationController,
    | "close"
    | "hasOpenAsSource"
    | "noteUnwatchedWaiting"
    | "noteUpdate"
    | "peekSource"
    | "silenceMs"
  >,
  targetTaskId: string,
  status: "waiting" | "blocked" | "done",
  body: string,
): AgentUpdatePersistenceResult {
  if (status === "waiting") {
    store.recordAgentWorkflowUpdate(
      targetTaskId,
      status,
      body,
      null,
      "waiting",
    );
    obligations.noteUpdate(targetTaskId);
    const wakeSourceVisible =
      obligations.hasOpenAsSource(targetTaskId) ||
      store.countQueuedDeliveries(targetTaskId) > 0 ||
      store.hasQueuedDispatchToChild(targetTaskId);
    const watched =
      !wakeSourceVisible && obligations.noteUnwatchedWaiting(targetTaskId);
    return {
      collaborationMessageId: null,
      accountTargetTaskId: null,
      ...(watched ? { silenceWatchMs: obligations.silenceMs } : {}),
    };
  }

  const accountSource = obligations.peekSource(targetTaskId);
  const accountTargetTaskId =
    accountSource ?? store.getTask(targetTaskId)?.parent_id ?? null;
  const { collaborationMessageId } = store.recordAgentWorkflowUpdate(
    targetTaskId,
    status,
    body,
    accountTargetTaskId,
    accountSource === undefined ? "fallback" : "settled",
  );
  obligations.noteUpdate(targetTaskId);
  if (accountSource !== undefined) obligations.close(targetTaskId);
  return { collaborationMessageId, accountTargetTaskId };
}
