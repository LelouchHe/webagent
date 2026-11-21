import type { ObligationNotice } from "./obligation-controller.ts";
import type {
  CollaborationDeliveryStatusChange,
  CollaborationMessageRow,
} from "./store.ts";

export type ObligationOutcomeFact =
  | {
      kind: "delivery_failed";
      change: CollaborationDeliveryStatusChange;
      message: Pick<CollaborationMessageRow, "source_actor" | "source_task_id">;
      openAccountSourceTaskId: string | undefined;
    }
  | {
      kind: "account_unsettled";
      notice: ObligationNotice;
    };

export type ObligationOutcomeDecision =
  | { kind: "none" }
  | {
      kind: "close_account";
      notice: ObligationNotice;
    }
  | {
      kind: "notice";
      notice: ObligationNotice;
    };

function deliveryFailureNotice(
  change: CollaborationDeliveryStatusChange,
  message: Pick<CollaborationMessageRow, "source_task_id">,
): ObligationNotice {
  return {
    reason: "target_removed",
    sourceTaskId: message.source_task_id,
    targetTaskId: change.recipientTaskId,
    message: `A message to the target was not delivered (${change.failureReason ?? "unknown"}).`,
  };
}

/**
 * One reducer for every failure fact that may produce an obligation notice.
 * A matching delivery closes its account; an unrelated failed delivery still
 * reports once without touching the account. An already-computed account
 * outcome is persisted as-is.
 */
export function reduceObligationOutcome(
  fact: ObligationOutcomeFact,
): ObligationOutcomeDecision {
  if (fact.kind === "account_unsettled") {
    return { kind: "notice", notice: fact.notice };
  }
  if (fact.message.source_actor !== "agent") return { kind: "none" };
  const notice = deliveryFailureNotice(fact.change, fact.message);
  return fact.openAccountSourceTaskId === fact.message.source_task_id
    ? { kind: "close_account", notice }
    : { kind: "notice", notice };
}
