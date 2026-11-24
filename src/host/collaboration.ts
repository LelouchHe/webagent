import { randomUUID } from "node:crypto";
import type { Store } from "../store.ts";
import type { TaskManager } from "../task-manager.ts";
import { formatTaskReport } from "../task-report.ts";
import type { HostStreamEvent } from "./remote/connection.ts";

export function createRemoteReportHandler(deps: {
  store: Store;
  tasks: TaskManager;
}) {
  return (host: string, childId: string, event: HostStreamEvent): void => {
    if (
      event.seq === undefined ||
      event.data.type !== "task_update" ||
      (event.data.status !== "done" && event.data.status !== "blocked") ||
      typeof event.data.body !== "string"
    ) {
      return;
    }
    const link = deps.store.getRemoteChildLink(host, childId);
    if (!link || event.data.targetTaskId !== link.local_task_id) return;
    const shouldDrain = deps.store.createRemoteReport({
      id: randomUUID(),
      deliveryId: randomUUID(),
      idempotencyKey: `remote-report:${host}:${childId}:${event.seq}`,
      sourceTaskId: childId,
      targetTaskId: link.local_task_id,
      body: formatTaskReport(event.data.status, event.data.body),
    });
    if (shouldDrain) {
      void deps.tasks.drainCollaborationDeliveries(link.local_task_id);
    }
  };
}
