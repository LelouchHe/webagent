import type { Store } from "../store.ts";
import type { HostStreamEvent } from "./remote/connection.ts";
import type { EnqueueRemoteReport } from "./tasks.ts";

export function createRemoteReportHandler(deps: {
  store: Store;
  enqueueReport: EnqueueRemoteReport;
}) {
  return (host: string, childId: string, event: HostStreamEvent): void => {
    const link = deps.store.getRemoteChild(host, childId);
    if (!link) return;
    if (
      event.data.type === "collaboration_prompt" &&
      Array.isArray(event.data.messageIds)
    ) {
      for (const messageId of event.data.messageIds) {
        if (typeof messageId === "string") {
          deps.store.markDeliveryDeliveredByMessage(messageId);
        }
      }
      return;
    }
    if (
      event.seq === undefined ||
      event.data.type !== "task_update" ||
      (event.data.status !== "done" && event.data.status !== "blocked") ||
      typeof event.data.body !== "string"
    ) {
      return;
    }
    if (event.data.targetTaskId !== link.local_task_id) return;
    deps.enqueueReport({
      host,
      childId,
      seq: event.seq,
      sourceTaskId: childId,
      targetTaskId: link.local_task_id,
      status: event.data.status,
      body: event.data.body,
    });
  };
}
