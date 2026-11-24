import { randomUUID } from "node:crypto";
import { formatTaskReport } from "../task-report.ts";
import type {
  RemoteTaskCreateTransport,
  TaskCaller,
  TaskCreateHost,
  TaskCreateHostCommand,
  TaskCreateResult,
  TaskOps,
  TaskListItem,
} from "../api/tasks.ts";
import { TaskRemoteCreateConfigError } from "../api/tasks.ts";
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
  remoteTitle: HostRouter["remoteTitle"];
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
      if (agentId === undefined) throw new Error("invalid_remote_create");
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
  const enqueueReport = createReportEnqueuer({
    store,
    tasks,
    broadcastCollaboration,
  });
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
      const performed = target
        ? await remote.sendRemote(target, body, sourceLabel)
        : await local.send(principal, targetTaskId, body);
      authorize(principal);
      if (target && !source) throw new Error("execution_replaced");
      const effectiveSourceLabel = performed.sourceLabel;
      const message = store.recordCallerSend({
        id: performed.messageId,
        deliveryId: performed.deliveryId,
        sourceTaskId: principal.taskId,
        directTargetTaskId: performed.targetTaskId,
        sourceLabel: effectiveSourceLabel,
        targetLabel: performed.targetLabel,
        body,
        targetIsLocal: performed.targetIsLocal,
      });
      broadcastCollaboration({
        messageId: message.id,
        sourceTaskId: principal.taskId,
        targetTaskId: performed.targetTaskId,
        sourceLabel: effectiveSourceLabel,
        targetLabel: performed.targetLabel,
        body,
        taskId: principal.taskId,
        role: "source",
        deliveryStatus: performed.targetIsLocal ? "queued" : "accepted",
      });
      if (performed.targetIsLocal) {
        void tasks.drainCollaborationDeliveries(performed.targetTaskId);
      }
      return performed;
    },
    async update(principal, status, body) {
      const result = await local.update(principal, status, body);
      if (result.report) {
        enqueueReport({ ...result.report, recordSource: true });
      }
      const { report: _report, ...publicResult } = result;
      return publicResult;
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
  sourceLabel?: string;
}) => boolean;

export function createRemoteReportEnqueuer(deps: {
  store: Store;
  tasks: TaskManager;
}): EnqueueRemoteReport {
  const enqueue = createReportEnqueuer(deps);
  return (input) => {
    return enqueue({
      sourceTaskId: input.sourceTaskId,
      targetTaskId: input.targetTaskId,
      status: input.status,
      body: input.body,
      sourceLabel: input.sourceLabel,
      idempotencyKey: `remote-report:${input.host}:${input.childId}:${input.seq}`,
    });
  };
}

function createReportEnqueuer(deps: {
  store: Store;
  tasks: TaskManager;
  broadcastCollaboration?: (event: TaskCollaborationEvent) => void;
}) {
  return (input: {
    sourceTaskId: string;
    targetTaskId: string;
    status: "blocked" | "done";
    body: string;
    sourceLabel?: string;
    targetLabel?: string;
    recordSource?: boolean;
    idempotencyKey?: string;
  }): boolean => {
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const shouldDrain = deps.store.enqueueReportDelivery({
      id: messageId,
      deliveryId,
      idempotencyKey:
        input.idempotencyKey ?? `${messageId}:${input.targetTaskId}`,
      sourceTaskId: input.sourceTaskId,
      targetTaskId: input.targetTaskId,
      body: formatTaskReport(input.status, input.body),
    });
    if (shouldDrain && input.recordSource) {
      if (input.sourceLabel && input.targetLabel) {
        deps.store.recordCallerSend({
          id: messageId,
          deliveryId,
          sourceTaskId: input.sourceTaskId,
          directTargetTaskId: input.targetTaskId,
          sourceLabel: input.sourceLabel,
          targetLabel: input.targetLabel,
          body: formatTaskReport(input.status, input.body),
          targetIsLocal: true,
          readLocalLabels: false,
        });
        deps.broadcastCollaboration?.({
          messageId,
          sourceTaskId: input.sourceTaskId,
          targetTaskId: input.targetTaskId,
          sourceLabel: input.sourceLabel,
          targetLabel: input.targetLabel,
          body: formatTaskReport(input.status, input.body),
          taskId: input.sourceTaskId,
          role: "source",
          deliveryStatus: "queued",
        });
      }
    }
    if (shouldDrain && input.sourceLabel) {
      deps.tasks.rememberCollaborationSourceLabel(messageId, input.sourceLabel);
    }
    if (shouldDrain) {
      void deps.tasks.drainCollaborationDeliveries(input.targetTaskId);
    }
    return shouldDrain;
  };
}
