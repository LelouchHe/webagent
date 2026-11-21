import {
  formatSilence,
  type ObligationNotice,
} from "./obligation-controller.ts";
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
      kind: "target_unavailable";
      sourceTaskId: string;
      targetTaskId: string;
    }
  | {
      kind: "repeated_unreported_turn";
      sourceTaskId: string;
      targetTaskId: string;
    }
  | {
      kind: "silent_account";
      sourceTaskId: string;
      targetTaskId: string;
      silenceMs: number;
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

function accountNotice(
  reason: ObligationNotice["reason"],
  sourceTaskId: string,
  targetTaskId: string,
  message: string,
): ObligationNotice {
  return { reason, sourceTaskId, targetTaskId, message };
}

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
  if (fact.kind === "target_unavailable") {
    return {
      kind: "notice",
      notice: accountNotice(
        "target_removed",
        fact.sourceTaskId,
        fact.targetTaskId,
        "The target left this edge (deleted or archived); the account is gone.",
      ),
    };
  }
  if (fact.kind === "repeated_unreported_turn") {
    return {
      kind: "notice",
      notice: accountNotice(
        "no_update",
        fact.sourceTaskId,
        fact.targetTaskId,
        "The target ended another turn without any task_update; the runtime stopped reminding.",
      ),
    };
  }
  if (fact.kind === "silent_account") {
    return {
      kind: "notice",
      notice: accountNotice(
        "no_activity",
        fact.sourceTaskId,
        fact.targetTaskId,
        `No agent activity for ${formatSilence(fact.silenceMs)} while the account is open.`,
      ),
    };
  }
  if (fact.message.source_actor !== "agent") return { kind: "none" };
  const notice = deliveryFailureNotice(fact.change, fact.message);
  return fact.openAccountSourceTaskId === fact.message.source_task_id
    ? { kind: "close_account", notice }
    : { kind: "notice", notice };
}
