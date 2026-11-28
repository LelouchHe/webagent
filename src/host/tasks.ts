import { randomUUID } from "node:crypto";
import { formatTaskReport } from "../task-report.ts";
import { recordTaskCancelEvent } from "../task-cancel-record.ts";
import type {
  RemoteTaskCreateTransport,
  TaskCaller,
  TaskCancelCommand,
  TaskCreateHost,
  TaskCreateHostCommand,
  TaskCreateResult,
  TaskSendResult,
  TaskOps,
  TaskListItem,
} from "../api/tasks.ts";
import {
  MAX_HOST_CANCEL_SOURCE_LABEL_LENGTH,
  TaskCreateInputError,
  TaskRemoteCreateConfigError,
} from "../api/tasks.ts";
import type { Store } from "../store.ts";
import { TaskNotFoundError, type TaskManager } from "../task-manager.ts";
import { assertTaskCaller } from "./local/adapter.ts";
import type { RemoteTaskTarget } from "./remote/registry.ts";

interface RoutedRemoteHost {
  hasConnections(): boolean;
  listRemoteChildren(taskId: string): Promise<TaskListItem[]>;
  resolveRemoteChild: HostRouter["resolveRemoteChild"];
  resolveRemoteChildByTaskId: HostRouter["resolveRemoteChildByTaskId"];
  cancelRemote: HostRouter["cancelRemote"];
  queryRemote: HostRouter["queryRemote"];
  readRemote: HostRouter["readRemote"];
}

type HostRouter = import("./remote/registry.ts").HostRegistry;

export type CancelRoute =
  | { kind: "local" }
  | { kind: "remote"; target: RemoteTaskTarget }
  | { kind: "not_found"; taskId: string };

function truncateUtf16(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function resolveCancelTarget(
  command: TaskCancelCommand,
  store: Pick<Store, "getTask">,
  remote: Pick<
    RoutedRemoteHost,
    "hasConnections" | "resolveRemoteChild" | "resolveRemoteChildByTaskId"
  >,
): CancelRoute {
  if (command.kind === "host") {
    return { kind: "local" };
  }
  if (command.kind === "user") {
    if (!remote.hasConnections()) return { kind: "local" };
    if (store.getTask(command.taskId)) return { kind: "local" };
    const target = remote.resolveRemoteChildByTaskId(
      command.taskId,
      (localParentId) => store.getTask(localParentId) !== undefined,
    );
    return target
      ? { kind: "remote", target }
      : { kind: "not_found", taskId: command.taskId };
  }
  const target = remote.resolveRemoteChild(
    command.principal.taskId,
    command.targetTaskId,
  );
  return target ? { kind: "remote", target } : { kind: "local" };
}

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
        opId: command.input.opId,
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
}): Pick<TaskOps, "list" | "query" | "read" | "send" | "update" | "cancel"> {
  const { local, remote, store, tasks } = deps;
  const authorize = (principal: TaskCaller) => {
    assertTaskCaller(tasks, principal);
  };
  return {
    async cancel(command) {
      if (command.kind === "host") return local.cancel(command);
      if (command.kind === "agent") authorize(command.principal);
      const route = resolveCancelTarget(command, store, remote);
      if (route.kind === "not_found") {
        throw new TaskNotFoundError(route.taskId);
      }
      if (route.kind === "local") {
        return local.cancel(command);
      }
      if (command.kind === "user") {
        const status = await remote.cancelRemote(route.target, {
          kind: "user",
        });
        return { accepted: true, taskId: route.target.taskId, status };
      }
      const sourceTaskId = command.principal.taskId;
      const sourceTask = store.getTask(sourceTaskId);
      if (!sourceTask) throw new Error("execution_replaced");
      const trimmedTitle = sourceTask.title?.trim();
      const sourceLabel = truncateUtf16(
        trimmedTitle && trimmedTitle.length > 0
          ? trimmedTitle
          : sourceTaskId.slice(0, 8),
        MAX_HOST_CANCEL_SOURCE_LABEL_LENGTH,
      );
      const status = await remote.cancelRemote(
        route.target,
        {
          kind: "agent",
          reason: command.reason,
          sourceLabel,
        },
        () => {
          authorize(command.principal);
        },
      );
      authorize(command.principal);
      const targetLabel =
        store.getRemoteChildTitle(sourceTaskId, route.target.taskId) ??
        route.target.taskId.slice(0, 8);
      recordTaskCancelEvent({
        store,
        role: "source",
        sourceTaskId,
        sourceLabel,
        targetTaskId: route.target.taskId,
        targetLabel,
        reason: command.reason,
        status,
      });
      return { accepted: true, taskId: route.target.taskId, status };
    },
    async list(principal) {
      authorize(principal);
      const order = { self: 0, parent: 1, child: 2 } as const;
      const [localItems, remoteItems] = await Promise.all([
        local.list(principal),
        remote.listRemoteChildren(principal.taskId),
      ]);
      return [...localItems, ...remoteItems].sort(
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
      const externalParent = target
        ? undefined
        : store.getExternalParentLink(principal.taskId);
      const remoteLink = target
        ? {
            remoteRole: "child" as const,
            remoteHost: target.host,
            targetTaskId: target.taskId,
            targetLabel:
              store.getRemoteChildTitle(principal.taskId, target.taskId) ??
              target.taskId.slice(0, 8),
          }
        : externalParent?.remote_task_id === targetTaskId
          ? {
              remoteRole: "parent" as const,
              remoteHost: externalParent.remote_host,
              targetTaskId: externalParent.remote_task_id,
              targetLabel:
                store.getLatestInboundSourceLabel(
                  principal.taskId,
                  externalParent.remote_task_id,
                  "parent",
                  externalParent.remote_host,
                ) ?? externalParent.remote_task_id.slice(0, 8),
            }
          : undefined;
      if (remoteLink) {
        const source = store.getTask(principal.taskId);
        if (!source) throw new Error("execution_replaced");
        const sourceLabel = source.title ?? principal.taskId.slice(0, 8);
        const row = store.enqueueLinkMessage({
          remoteRole: remoteLink.remoteRole,
          remoteHost: remoteLink.remoteHost,
          sourceTaskId: principal.taskId,
          targetTaskId: remoteLink.targetTaskId,
          sourceLabel,
          targetLabel: remoteLink.targetLabel,
          body,
        });
        return {
          messageId: row.entry_id,
          deliveryId: row.delivery_id ?? undefined,
          targetTaskId: remoteLink.targetTaskId,
          targetLabel: remoteLink.targetLabel,
          sourceLabel,
        };
      }
      const record = (performed: TaskSendResult) => {
        authorize(principal);
        store.recordCallerSend({
          id: performed.messageId,
          sourceTaskId: principal.taskId,
          directTargetTaskId: performed.targetTaskId,
          sourceLabel: performed.sourceLabel,
          targetLabel: performed.targetLabel,
          body,
          deliveryId: performed.deliveryId,
        });
      };
      const performed = await local.send(principal, targetTaskId, body, record);
      void tasks.drainCollaborationDeliveries(performed.targetTaskId);
      return performed;
    },
    async update(principal, status, body) {
      let afterCommit: (() => void) | undefined;
      const result = await local.update(principal, status, body, (report) => {
        authorize(principal);
        const text = formatTaskReport(status, body);
        if (!report.targetIsLocal) {
          const link = store.getExternalParentLink(report.sourceTaskId);
          if (link?.remote_task_id !== report.targetTaskId) {
            throw new Error("external_parent_link_missing");
          }
          store.enqueueLinkReport({
            remoteRole: "parent",
            remoteHost: link.remote_host,
            sourceTaskId: report.sourceTaskId,
            targetTaskId: report.targetTaskId,
            sourceLabel: report.sourceLabel,
            body: text,
          });
          return;
        }
        const messageId = randomUUID();
        const deliveryId = randomUUID();
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
          deliveryId,
        });
        afterCommit = () => {
          void tasks.drainCollaborationDeliveries(report.targetTaskId);
        };
      });
      afterCommit?.();
      return result;
    },
  };
}
