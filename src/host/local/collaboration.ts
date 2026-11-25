import { randomUUID } from "node:crypto";
import type { Store } from "../../store.ts";
import type { TaskManager } from "../../task-manager.ts";
import { taskDisplayLabel } from "../../shared/task-title.ts";
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
          .getRemoteTasks(target.id)
          .some(
            (link) =>
              link.remote_role === "parent" &&
              link.remote_task_id === input.sourceTaskId,
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
      const sourceLabel = taskDisplayLabel(input.sourceLabel);
      if (sourceLabel) {
        deps.tasks.rememberCollaborationSourceLabel(messageId, sourceLabel);
      }
      void deps.tasks.drainCollaborationDeliveries(target.id);
      return { messageId, deliveryId };
    },
  };
}
