import type { Store } from "./store.ts";
import type { TaskManager } from "./task-manager.ts";
import type {
  TaskCaller,
  TaskCreateCaller,
  TaskCreateInput,
  TaskCreateResult,
  TaskOps,
} from "./api/tasks.ts";
import {
  MAX_HOST_CANCEL_SOURCE_LABEL_LENGTH,
  TaskCreateInputError,
  TaskRemoteCreatePartialSuccessError,
} from "./api/tasks.ts";
import type { TaskCreateTarget, TaskHost } from "./host/api.ts";
import { formatSilence } from "./obligation-controller.ts";
import { recordTaskCancelEvent } from "./task-cancel-record.ts";
import { buildTaskCreatedSystemMessage } from "./task-created-message.ts";
import { formatTaskReport } from "./task-report.ts";
import type { AgentEvent } from "./types.ts";

function truncateUtf16(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function buildTarget(caller: TaskCreateCaller, input: TaskCreateInput) {
  if (input.agentId?.includes("@")) {
    throw new TaskCreateInputError(
      "invalid_agent",
      "agentId must be a bare agent id",
    );
  }
  const target: TaskCreateTarget = {
    agentId: input.agentId,
    ...(input.host === undefined ? {} : { host: input.host }),
  };
  if (target.host !== undefined && caller.kind === "host") {
    throw new TaskCreateInputError(
      "invalid_remote_host",
      "Host credentials cannot relay a remote target",
    );
  }
  return target;
}

export function createTaskOpsCore(deps: {
  host: TaskHost;
  store: Store;
  tasks: TaskManager;
  broadcastConfigUpdate?: (
    event: Extract<AgentEvent, { type: "config_option_update" }>,
  ) => void;
}): TaskOps {
  const { host, store, tasks } = deps;

  /**
   * The single authority check for one agent-originated Task operation.
   *
   * The generation is the fence: a token names the generation it was promoted
   * for, and every binding change bumps the task's generation, so a moved
   * binding is refused by `accepts`. Fail closed on missing or stale generation.
   */
  function authorizeAgent(principal: TaskCaller): void {
    if (principal.generation === null) {
      throw new Error("execution_replaced");
    }
    if (
      !tasks.authority.accepts({
        taskId: principal.taskId,
        generation: principal.generation,
      })
    ) {
      throw new Error("execution_replaced");
    }
  }

  function authorizeCreateCaller(caller: TaskCreateCaller): void {
    if (caller.kind !== "agent") return;
    authorizeAgent(caller.principal);
  }

  function requireTask(taskId: string) {
    const task = store.getTask(taskId);
    if (!task) throw new Error("task_not_found");
    return task;
  }

  return {
    async list(principal) {
      authorizeAgent(principal);
      const order = { self: 0, parent: 1, child: 2 } as const;
      const items = await host.list(principal);
      return [...items].sort(
        (left, right) =>
          order[left.relation] - order[right.relation] ||
          left.id.localeCompare(right.id),
      );
    },

    async query(principal, input) {
      authorizeAgent(principal);
      return host.query(principal, input);
    },

    async read(principal, input) {
      authorizeAgent(principal);
      return host.read(principal, input);
    },

    // eslint-disable-next-line complexity -- one command authorizes, creates, links, and records one operation.
    async create(
      caller: TaskCreateCaller,
      input: TaskCreateInput,
    ): Promise<TaskCreateResult> {
      if (
        caller.kind === "host" &&
        (typeof input.parentId !== "string" || input.parentId.trim() === "")
      ) {
        throw new TaskCreateInputError(
          "external_parent_required",
          "Host task creation requires a non-empty parentId",
        );
      }
      const localParentId =
        caller.kind === "agent"
          ? caller.principal.taskId
          : caller.kind === "user"
            ? (input.parentId ?? store.rootTaskId)
            : input.parentId;
      const assertCaller = () => {
        authorizeCreateCaller(caller);
        if (caller.kind === "agent") {
          if (
            input.parentId !== caller.principal.taskId ||
            input.inheritFromTaskId !== caller.principal.taskId
          ) {
            throw new Error("target_not_allowed");
          }
        }
      };
      assertCaller();
      const target = buildTarget(caller, input);
      const outcome = await host.create({
        caller,
        input,
        target,
        parentId: localParentId,
        assertCaller,
        assertRemoteCaller: () => {
          if (
            caller.kind === "user" &&
            (typeof localParentId !== "string" ||
              !localParentId.trim() ||
              !store.getParentTask(localParentId))
          ) {
            throw new Error("parent_not_found");
          }
        },
      });
      const { result } = outcome;
      if (outcome.kind === "local" && outcome.replayed) {
        if (caller.kind === "agent") return { ...result, session: undefined };
        return result;
      }
      let taskCreated:
        ReturnType<typeof buildTaskCreatedSystemMessage> | undefined;
      const prepareRecord = (remoteHost?: string) => {
        if (caller.kind === "host" || !localParentId || !input.title) return;
        if (result.task.title === null) {
          throw new Error("task_create_facts_incomplete");
        }
        const taskTitle = result.task.title;
        taskCreated = buildTaskCreatedSystemMessage({
          taskId: result.task.id,
          taskTitle,
          agentId: result.task.agentId,
          host: remoteHost,
          cwd: result.task.cwd,
          model: result.task.model,
          thinking: result.task.thinking,
        });
        if (remoteHost === undefined) {
          store.saveEvent(localParentId, "system_message", taskCreated.data, {
            from_ref: caller.kind === "agent" ? "agent" : "user",
          });
        }
      };
      if (outcome.kind === "remote") {
        const remoteHost = outcome.host;
        if (localParentId === undefined) throw new Error("parent_not_found");
        try {
          assertCaller();
          if (caller.kind === "user" && !store.getParentTask(localParentId)) {
            throw new Error("parent_not_found");
          }
          prepareRecord(remoteHost);
          if (taskCreated) {
            store.recordRemoteChild(localParentId, result.task.id, remoteHost, {
              data: taskCreated.data,
              fromRef: caller.kind === "agent" ? "agent" : "user",
            });
          } else {
            store.recordRemoteChild(localParentId, result.task.id, remoteHost);
          }
        } catch (error) {
          throw new TaskRemoteCreatePartialSuccessError(
            remoteHost,
            result.task.id,
            { cause: error },
          );
        }
        if (caller.kind === "agent") return { ...result, session: undefined };
        if (result.session) {
          return {
            ...result,
            task: { ...result.task, parentId: localParentId },
            session: {
              ...result.session,
              parentAgentId: store.getBindingAgent(localParentId) ?? null,
            },
          };
        }
        return result;
      }
      assertCaller();
      prepareRecord();
      if (caller.kind !== "agent" && result.session?.configOptions.length) {
        deps.broadcastConfigUpdate?.({
          type: "config_option_update",
          taskId: result.task.id,
          configOptions: result.session.configOptions,
        });
      }
      if (caller.kind === "agent") return { ...result, session: undefined };
      return result;
    },

    async cancel(command) {
      if (command.kind === "host") {
        const outcome = await host.cancel({
          kind: "host",
          taskId: command.taskId,
        });
        if (command.actor.kind === "agent") {
          const targetTask = store.getTaskIncludingDeleted(command.taskId);
          recordTaskCancelEvent({
            store,
            role: "target",
            sourceTaskId: command.actor.sourceTaskId,
            sourceLabel: command.actor.sourceLabel,
            targetTaskId: command.taskId,
            targetLabel: targetTask?.title ?? command.taskId.slice(0, 8),
            reason: command.actor.reason,
            status: outcome.status,
          });
        }
        return {
          accepted: true,
          taskId: outcome.taskId,
          status: outcome.status,
        };
      }
      if (command.kind === "user") {
        const outcome = await host.cancel({
          kind: "user",
          taskId: command.taskId,
        });
        return {
          accepted: true,
          taskId: outcome.taskId,
          status: outcome.status,
        };
      }

      authorizeAgent(command.principal);
      const sourceTaskId = command.principal.taskId;
      let remoteSourceLabel = "";
      const outcome = await host.cancel({
        kind: "agent",
        sourceTaskId,
        targetTaskId: command.targetTaskId,
        reason: command.reason,
        prepareLocal: () => {
          const source = requireTask(sourceTaskId);
          const target = requireTask(command.targetTaskId);
          if (target.parent_id !== source.id) {
            throw new Error("target_not_allowed");
          }
        },
        prepareRemote: () => {
          const sourceTask = store.getTask(sourceTaskId);
          if (!sourceTask) throw new Error("execution_replaced");
          const trimmedTitle = sourceTask.title?.trim();
          remoteSourceLabel = truncateUtf16(
            trimmedTitle && trimmedTitle.length > 0
              ? trimmedTitle
              : sourceTaskId.slice(0, 8),
            MAX_HOST_CANCEL_SOURCE_LABEL_LENGTH,
          );
          return { sourceLabel: remoteSourceLabel };
        },
        beforeSend: () => {
          authorizeAgent(command.principal);
        },
      });
      // The cancel awaited a transport round trip; the record of what happened
      // is only written while the caller still owns its execution.
      authorizeAgent(command.principal);
      if (outcome.kind === "remote") {
        const targetLabel =
          store.getRemoteChildTitle(sourceTaskId, outcome.taskId) ??
          outcome.taskId.slice(0, 8);
        recordTaskCancelEvent({
          store,
          role: "source",
          sourceTaskId,
          sourceLabel: remoteSourceLabel,
          targetTaskId: outcome.taskId,
          targetLabel,
          reason: command.reason,
          status: outcome.status,
        });
      } else {
        const sourceTask = store.getTaskIncludingDeleted(sourceTaskId);
        const targetTask = store.getTaskIncludingDeleted(outcome.taskId);
        const sourceLabel = sourceTask?.title ?? sourceTaskId.slice(0, 8);
        const targetLabel = targetTask?.title ?? outcome.taskId.slice(0, 8);
        for (const role of ["source", "target"] as const) {
          recordTaskCancelEvent({
            store,
            role,
            sourceTaskId,
            sourceLabel,
            targetTaskId: outcome.taskId,
            targetLabel,
            reason: command.reason,
            status: outcome.status,
          });
        }
      }
      return {
        accepted: true,
        taskId: outcome.taskId,
        status: outcome.status,
      };
    },

    async send(principal, targetTaskId, body) {
      authorizeAgent(principal);
      const outcome = await host.send({
        principal,
        targetTaskId,
        body,
        recordLocalSend: (performed) => {
          authorizeAgent(principal);
          store.recordCallerSend({
            id: performed.messageId,
            sourceTaskId: principal.taskId,
            directTargetTaskId: performed.targetTaskId,
            sourceLabel: performed.sourceLabel,
            targetLabel: performed.targetLabel,
            body,
            deliveryId: performed.deliveryId,
          });
        },
      });
      if (outcome.kind === "local") {
        void tasks.drainCollaborationDeliveries(outcome.result.targetTaskId);
      }
      return outcome.result;
    },

    async update(principal, status, body) {
      authorizeAgent(principal);
      const sourceTaskId = principal.taskId;
      let drainTargetTaskId: string | undefined;
      // `waiting` only records the status. `done` and `blocked` settle the
      // target's open account and are delivered to its source, or fall back to
      // the current parent when no account is open.
      const { silenceWatchMs } = tasks.settleAgentUpdate(
        sourceTaskId,
        status,
        body,
        ({ targetTaskId, targetIsLocal }) => {
          if (status === "waiting") return;
          authorizeAgent(principal);
          const text = formatTaskReport(status, body);
          const delivered = host.deliverReport({
            sourceTaskId,
            targetTaskId,
            targetIsLocal,
            sourceLabel:
              store.getTask(sourceTaskId)?.title ?? sourceTaskId.slice(0, 8),
            targetLabel: targetIsLocal
              ? (store.getTask(targetTaskId)?.title ?? targetTaskId.slice(0, 8))
              : targetTaskId.slice(0, 8),
            body: text,
          });
          if (delivered.drainLocalTargetTaskId) {
            drainTargetTaskId = delivered.drainLocalTargetTaskId;
          }
        },
      );
      if (drainTargetTaskId) {
        void tasks.drainCollaborationDeliveries(drainTargetTaskId);
      }
      if (silenceWatchMs === undefined) return {};
      return {
        note: `No visible wake source; the requester is notified after ${formatSilence(silenceWatchMs)} without agent activity.`,
      };
    },
  };
}
