import type { Store } from "../store.ts";
import type { HostStreamEvent } from "./remote/connection.ts";
import type { EnqueueRemoteReport } from "./tasks.ts";

export function createRemoteReportHandler(deps: {
  store: Store;
  sourceLabel: (host: string, childId: string) => string | undefined;
  enqueueReport: EnqueueRemoteReport;
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
    deps.enqueueReport({
      host,
      childId,
      seq: event.seq,
      sourceTaskId: childId,
      targetTaskId: link.local_task_id,
      status: event.data.status,
      body: event.data.body,
      sourceLabel: deps.sourceLabel(host, childId),
    });
  };
}
