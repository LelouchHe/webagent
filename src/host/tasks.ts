import { randomUUID } from "node:crypto";
import { formatTaskReport } from "../task-report.ts";
import type {
  RemoteTaskCreateTransport,
  TaskCaller,
  TaskCreateHost,
  TaskCreateHostCommand,
  TaskCreateResult,
  TaskSendResult,
  TaskOps,
  TaskListItem,
} from "../api/tasks.ts";
import {
  TaskCreateInputError,
  TaskRemoteCreateConfigError,
} from "../api/tasks.ts";
import type { Store } from "../store.ts";
import type { TaskManager } from "../task-manager.ts";
import {
  assertTaskCaller,
  type TaskCollaborationEvent,
} from "./local/adapter.ts";
interface RoutedRemoteHost {
  listRemoteChildren(taskId: string): TaskListItem[];
  resolveRemoteChild: HostRouter["resolveRemoteChild"];
  queryRemote: HostRouter["queryRemote"];
  readRemote: HostRouter["readRemote"];
  sendRemote: HostRouter["sendRemote"];
}

type HostRouter = import("./remote/registry.ts").HostRegistry;

export function createTaskHost(deps: {
  local: TaskOps;
  remote: RemoteTaskCreateTransport;
}): TaskCreateHost {
  return {
    async create(command: TaskCreateHostCommand): Promise<TaskCreateResult> {
      if (command.target.host === undefined) {
        return deps.local.create(command.caller, {
          ...command.input,
          agentId: command.target.agentId,
        });
      }
      if (command.input.model) throw new TaskRemoteCreateConfigError("model");
      if (command.input.thinking) {
        throw new TaskRemoteCreateConfigError("thinking");
      }
      const host = command.target.host;
      const agentId = command.target.agentId;
      if (agentId === undefined)
        throw new TaskCreateInputError(
          "agent_required",
          "A remote target requires an explicit agent",
        );
      if (!command.parentId) throw new Error("parent_not_found");
      command.assertRemoteCaller();
      const remote = await deps.remote.create(host, {
        agentId,
        parentId: command.parentId,
        ...(command.input.title === undefined
          ? {}
          : { title: command.input.title }),
        ...(command.input.cwd === undefined ? {} : { cwd: command.input.cwd }),
        source:
          command.input.source ??
          (command.caller.kind === "agent" ? "agent" : "auto"),
      });
      return remote;
    },
  };
}

export function createRoutedTaskOps(deps: {
  local: TaskOps;
  remote: RoutedRemoteHost;
  store: Store;
  tasks: TaskManager;
  broadcastCollaboration: (event: TaskCollaborationEvent) => void;
}): Pick<TaskOps, "list" | "query" | "read" | "send" | "update"> {
  const { local, remote, store, tasks, broadcastCollaboration } = deps;
  const authorize = (principal: TaskCaller) => {
    assertTaskCaller(tasks, principal);
  };
  return {
    async list(principal) {
      authorize(principal);
      const order = { self: 0, parent: 1, child: 2 } as const;
      return [
        ...(await local.list(principal)),
        ...remote.listRemoteChildren(principal.taskId),
      ].sort(
        (left, right) =>
          order[left.relation] - order[right.relation] ||
          left.id.localeCompare(right.id),
      );
    },
    async query(principal, input) {
      authorize(principal);
      const target = remote.resolveRemoteChild(
        principal.taskId,
        input.taskId ?? principal.taskId,
      );
      return target
        ? remote.queryRemote(target, input)
        : local.query(principal, input);
    },
    async read(principal, input) {
      authorize(principal);
      const target = remote.resolveRemoteChild(
        principal.taskId,
        input.taskId ?? principal.taskId,
      );
      return target
        ? remote.readRemote(target, input)
        : local.read(principal, input);
    },
    async send(principal, targetTaskId, body) {
      authorize(principal);
      const target = remote.resolveRemoteChild(principal.taskId, targetTaskId);
      const source = target ? store.getTask(principal.taskId) : null;
      const sourceLabel = target
        ? (source?.title ?? principal.taskId.slice(0, 8))
        : "";
      const record = (performed: TaskSendResult) => {
        authorize(principal);
        store.recordCallerSend({
          id: performed.messageId,
          sourceTaskId: principal.taskId,
          directTargetTaskId: performed.targetTaskId,
          sourceLabel: performed.sourceLabel,
          targetLabel: performed.targetLabel,
          body,
          targetIsLocal: performed.targetIsLocal,
        });
      };
      const performed = target
        ? await remote.sendRemote(target, body, sourceLabel)
        : await local.send(principal, targetTaskId, body, record);
      if (target) {
        authorize(principal);
        if (!source) throw new Error("execution_replaced");
        record(performed);
      }
      const effectiveSourceLabel = performed.sourceLabel;
      broadcastCollaboration({
        messageId: performed.messageId,
        sourceTaskId: principal.taskId,
        targetTaskId: performed.targetTaskId,
        sourceLabel: effectiveSourceLabel,
        targetLabel: performed.targetLabel,
        body,
        taskId: principal.taskId,
        role: "source",
        deliveryStatus: "queued",
      });
      if (performed.targetIsLocal) {
        void tasks.drainCollaborationDeliveries(performed.targetTaskId);
      }
      return performed;
    },
    async update(principal, status, body) {
      let afterCommit: (() => void) | undefined;
      const result = await local.update(principal, status, body, (report) => {
        authorize(principal);
        const messageId = randomUUID();
        const deliveryId = randomUUID();
        const text = formatTaskReport(status, body);
        if (
          !store.enqueueReportDelivery({
            id: messageId,
            deliveryId,
            idempotencyKey: `${messageId}:${report.targetTaskId}`,
            sourceTaskId: report.sourceTaskId,
            targetTaskId: report.targetTaskId,
            body: text,
          })
        ) {
          return;
        }
        store.recordCallerSend({
          id: messageId,
          sourceTaskId: report.sourceTaskId,
          directTargetTaskId: report.targetTaskId,
          sourceLabel: report.sourceLabel,
          targetLabel: report.targetLabel,
          body: text,
          targetIsLocal: true,
        });
        afterCommit = () => {
          broadcastCollaboration({
            messageId,
            sourceTaskId: report.sourceTaskId,
            targetTaskId: report.targetTaskId,
            sourceLabel: report.sourceLabel,
            targetLabel: report.targetLabel,
            body: text,
            taskId: report.sourceTaskId,
            role: "source",
            deliveryStatus: "queued",
          });
          void tasks.drainCollaborationDeliveries(report.targetTaskId);
        };
      });
      afterCommit?.();
      return result;
    },
  };
}

export type EnqueueRemoteReport = (input: {
  host: string;
  childId: string;
  seq: number;
  sourceTaskId: string;
  targetTaskId: string;
  status: "blocked" | "done";
  body: string;
}) => boolean;

export function createRemoteReportEnqueuer(deps: {
  store: Store;
  tasks: TaskManager;
}): EnqueueRemoteReport {
  return (input) => {
    const messageId = randomUUID();
    const accepted = deps.store.enqueueReportDelivery({
      id: messageId,
      deliveryId: randomUUID(),
      idempotencyKey: `remote-report:${input.host}:${input.childId}:${input.seq}`,
      sourceTaskId: input.sourceTaskId,
      targetTaskId: input.targetTaskId,
      body: formatTaskReport(input.status, input.body),
    });
    if (accepted)
      void deps.tasks.drainCollaborationDeliveries(input.targetTaskId);
    return accepted;
  };
}
