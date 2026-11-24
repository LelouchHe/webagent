import { randomUUID } from "node:crypto";
import type {
  RemoteTaskCreateTransport,
  TaskCaller,
  TaskCreateHost,
  TaskCreateHostCommand,
  TaskCreateResult,
  TaskOps,
  TaskListItem,
} from "../api/tasks.ts";
import {
  TaskRemoteCreateConfigError,
  TaskRemoteCreatePartialSuccessError,
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
      try {
        return command.completeRemote(remote, host);
      } catch (error) {
        throw new TaskRemoteCreatePartialSuccessError(host, remote.taskId, {
          cause: error,
        });
      }
    },
  };
}

export function createRoutedTaskOps(deps: {
  local: TaskOps;
  remote: RoutedRemoteHost;
  store: Store;
  tasks: TaskManager;
  broadcastCollaboration: (event: TaskCollaborationEvent) => void;
}): Pick<TaskOps, "list" | "query" | "read" | "send"> {
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
      if (!target) return local.send(principal, targetTaskId, body);
      await remote.sendRemote(target, body);
      authorize(principal);
      const source = store.getTask(principal.taskId);
      if (!source) throw new Error("execution_replaced");
      const targetLabel =
        remote.remoteTitle(target) ?? target.taskId.slice(0, 8);
      const message = store.recordAcceptedRemoteMessage({
        id: randomUUID(),
        sourceTaskId: source.id,
        directTargetTaskId: target.taskId,
        targetLabel,
        body,
      });
      broadcastCollaboration({
        messageId: message.id,
        sourceTaskId: source.id,
        targetTaskId: target.taskId,
        sourceLabel: source.title ?? source.id.slice(0, 8),
        targetLabel,
        body,
        taskId: source.id,
        role: "source",
        deliveryStatus: "accepted",
      });
    },
  };
}
