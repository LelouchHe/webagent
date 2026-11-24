import { randomUUID } from "node:crypto";
import type { Store } from "../../store.ts";
import type { TaskManager } from "../../task-manager.ts";
import {
  HostExternalParentError,
  type HostCollaborationCommand,
} from "../../api/collaboration.ts";

export function createHostCollaborationCommand(deps: {
  store: Store;
  tasks: TaskManager;
}): HostCollaborationCommand {
  return {
    receive(input) {
      const target = deps.store.getTask(input.targetTaskId);
      if (
        !target ||
        !deps.store
          .getRemoteTaskLinks(target.id)
          .some(
            (link) =>
              link.remote_role === "parent" &&
              link.remote_task_id === input.sourceTaskId &&
              link.peer_token_hash === input.peerTokenHash,
          )
      ) {
        throw new HostExternalParentError();
      }
      const messageId = randomUUID();
      const deliveryId = randomUUID();
      deps.store.createExternalSourceCollaborationMessage({
        id: messageId,
        deliveryId,
        sourceTaskId: input.sourceTaskId,
        directTargetTaskId: target.id,
        body: input.body,
      });
      void deps.tasks.drainCollaborationDeliveries(target.id);
      return { messageId, deliveryId };
    },
  };
}
