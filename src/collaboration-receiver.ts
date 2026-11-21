import type { ObligationController } from "./obligation-controller.ts";
import type {
  CollaborationDeliveryRow,
  CollaborationMessageRow,
  Store,
} from "./store.ts";
import { shouldArm } from "./task-collaboration.ts";

export interface ReceivedCollaborationDelivery {
  delivery: CollaborationDeliveryRow;
  message: CollaborationMessageRow;
}

/**
 * The receiver-side handoff entry. The Store owns the optimistic state
 * transition; this helper owns the process-local account effect that follows
 * the committed handoff. UI status publication remains a Store effect.
 */
export function handoffQueuedDeliveries(
  store: Store,
  obligations: Pick<ObligationController, "arm">,
  recipientTaskId: string,
): ReceivedCollaborationDelivery[] {
  const deliveries = store.claimQueuedDeliveries(recipientTaskId);
  const received = deliveries.map((delivery) => {
    const message = store.getCollaborationMessage(delivery.message_id);
    if (!message) {
      throw new Error(`Collaboration message missing: ${delivery.message_id}`);
    }
    return { delivery, message };
  });
  const target = store.getTaskIncludingDeleted(recipientTaskId);
  if (!target) return received;
  store.afterCommit(() => {
    for (const { message } of received) {
      if (shouldArm(message, target)) {
        obligations.arm(message.source_task_id, recipientTaskId);
      }
    }
  });
  return received;
}
