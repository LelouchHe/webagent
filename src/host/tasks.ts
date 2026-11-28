import type {
  RemoteTaskCreateTransport,
  TaskCancelHostCommand,
  TaskCancelHostOutcome,
  TaskCreateHostCommand,
  TaskCreateHostOutcome,
  TaskHost,
} from "./api.ts";
import type { TaskListItem } from "../api/tasks.ts";
import {
  TaskCreateInputError,
  TaskHostNotConfiguredError,
  TaskRemoteCreateConfigError,
} from "../api/tasks.ts";
import type { Store } from "../store.ts";
import { TaskNotFoundError } from "../task-manager.ts";
import type { LocalTaskHost } from "./local/adapter.ts";
import type { HostRegistry, RemoteTaskTarget } from "./remote/registry.ts";

export interface RoutedRemoteHost {
  create?: RemoteTaskCreateTransport["create"];
  hasConnections?: () => boolean;
  listRemoteChildren?: (taskId: string) => Promise<TaskListItem[]>;
  resolveRemoteChild?: HostRegistry["resolveRemoteChild"];
  resolveRemoteChildByTaskId?: HostRegistry["resolveRemoteChildByTaskId"];
  cancelRemote?: HostRegistry["cancelRemote"];
  queryRemote?: HostRegistry["queryRemote"];
  readRemote?: HostRegistry["readRemote"];
}

export type CancelRoute =
  | { kind: "local" }
  | { kind: "remote"; target: RemoteTaskTarget }
  | { kind: "not_found"; taskId: string };

export type CancelRouteCommand =
  | { kind: "host"; taskId: string }
  | { kind: "user"; taskId: string }
  | { kind: "agent"; sourceTaskId: string; targetTaskId: string };

export function resolveCancelTarget(
  command: CancelRouteCommand,
  store: Pick<Store, "getTask">,
  remote?: Pick<
    RoutedRemoteHost,
    "hasConnections" | "resolveRemoteChild" | "resolveRemoteChildByTaskId"
  >,
): CancelRoute {
  if (command.kind === "host") {
    return { kind: "local" };
  }
  if (command.kind === "user") {
    if (!remote?.hasConnections?.()) return { kind: "local" };
    if (store.getTask(command.taskId)) return { kind: "local" };
    const target = remote.resolveRemoteChildByTaskId?.(
      command.taskId,
      (localParentId) => store.getTask(localParentId) !== undefined,
    );
    return target
      ? { kind: "remote", target }
      : { kind: "not_found", taskId: command.taskId };
  }
  const target = remote?.resolveRemoteChild?.(
    command.sourceTaskId,
    command.targetTaskId,
  );
  return target ? { kind: "remote", target } : { kind: "local" };
}

export function createTaskHost(deps: {
  local: LocalTaskHost;
  remote?: RoutedRemoteHost;
  store: Store;
}): TaskHost {
  const { local, remote, store } = deps;

  return {
    async list(principal) {
      const [localItems, remoteItems] = await Promise.all([
        local.list(principal),
        remote?.listRemoteChildren?.(principal.taskId) ?? Promise.resolve([]),
      ]);
      return [...localItems, ...remoteItems];
    },

    async query(principal, input) {
      const target = remote?.resolveRemoteChild?.(
        principal.taskId,
        input.taskId ?? principal.taskId,
      );
      if (target && remote?.queryRemote) {
        return remote.queryRemote(target, input);
      }
      return local.query(principal, input);
    },

    async read(principal, input) {
      const target = remote?.resolveRemoteChild?.(
        principal.taskId,
        input.taskId ?? principal.taskId,
      );
      if (target && remote?.readRemote) {
        return remote.readRemote(target, input);
      }
      return local.read(principal, input);
    },

    async create(
      command: TaskCreateHostCommand,
    ): Promise<TaskCreateHostOutcome> {
      if (command.target.host === undefined) {
        const localOutcome = await local.create(
          command.caller,
          {
            ...command.input,
            agentId: command.target.agentId,
          },
          command.assertCaller,
        );
        return {
          kind: "local",
          replayed: localOutcome.replayed,
          result: localOutcome.result,
        };
      }
      if (command.input.model) throw new TaskRemoteCreateConfigError("model");
      if (command.input.thinking) {
        throw new TaskRemoteCreateConfigError("thinking");
      }
      const host = command.target.host;
      const agentId = command.target.agentId;
      if (agentId === undefined) {
        throw new TaskCreateInputError(
          "agent_required",
          "A remote target requires an explicit agent",
        );
      }
      if (!command.parentId) throw new Error("parent_not_found");
      command.assertRemoteCaller();
      if (!remote?.create) {
        throw new TaskHostNotConfiguredError(host);
      }
      const result = await remote.create(host, {
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
      return {
        kind: "remote",
        host,
        result,
      };
    },

    async cancel(
      command: TaskCancelHostCommand,
    ): Promise<TaskCancelHostOutcome> {
      if (command.kind === "host") {
        const status = await local.cancel(command.taskId);
        return { kind: "local", taskId: command.taskId, status };
      }
      const route = resolveCancelTarget(command, store, remote);
      if (route.kind === "not_found") {
        throw new TaskNotFoundError(route.taskId);
      }
      if (route.kind === "local") {
        if (command.kind === "agent") {
          command.prepareLocal();
          const status = await local.cancel(command.targetTaskId);
          return { kind: "local", taskId: command.targetTaskId, status };
        }
        const status = await local.cancel(command.taskId);
        return { kind: "local", taskId: command.taskId, status };
      }
      if (!remote?.cancelRemote) {
        throw new TaskHostNotConfiguredError(route.target.host);
      }
      if (command.kind === "user") {
        const status = await remote.cancelRemote(route.target, {
          kind: "user",
        });
        return { kind: "remote", taskId: route.target.taskId, status };
      }
      const { sourceLabel } = command.prepareRemote();
      const status = await remote.cancelRemote(
        route.target,
        {
          kind: "agent",
          reason: command.reason,
          sourceLabel,
        },
        command.beforeSend,
      );
      return { kind: "remote", taskId: route.target.taskId, status };
    },

    async send(command) {
      const { principal, targetTaskId, body, recordLocalSend } = command;
      const target = remote?.resolveRemoteChild?.(
        principal.taskId,
        targetTaskId,
      );
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
          kind: "remote",
          result: {
            messageId: row.entry_id,
            deliveryId: row.delivery_id ?? undefined,
            targetTaskId: remoteLink.targetTaskId,
            targetLabel: remoteLink.targetLabel,
            sourceLabel,
          },
        };
      }
      const result = await local.send(
        principal,
        targetTaskId,
        body,
        recordLocalSend,
      );
      return { kind: "local", result };
    },

    deliverReport(report) {
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
          body: report.body,
        });
        return {};
      }
      return local.deliverReport(report);
    },
  };
}
