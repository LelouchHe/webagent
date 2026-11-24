import type { Store } from "./store.ts";
import type { TaskManager } from "./task-manager.ts";
import type {
  TaskCreateCaller,
  TaskCreateHost,
  TaskCreateInput,
  TaskCreateResult,
  TaskCreateTarget,
  TaskOps,
} from "./api/tasks.ts";
import {
  TaskAgentIdTypeError,
  TaskCreateInputError,
  TaskRemoteCreatePartialSuccessError,
} from "./api/tasks.ts";
import {
  buildTaskCreatedSystemMessage,
  type TaskCreatedBroadcastInput,
} from "./task-created-message.ts";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./types.ts";

function buildTarget(caller: TaskCreateCaller, input: TaskCreateInput) {
  if (input.agentId !== undefined && typeof input.agentId !== "string") {
    throw new TaskAgentIdTypeError();
  }
  if (input.agentId?.includes("@")) {
    throw new TaskCreateInputError(
      "invalid_agent",
      "agentId must be a bare agent id",
    );
  }
  if (input.host !== undefined && typeof input.host !== "string") {
    throw new TaskCreateInputError("invalid_host", "host must be a string");
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
  host: TaskCreateHost;
  store: Store;
  tasks: TaskManager;
  broadcastTaskCreated?: (event: TaskCreatedBroadcastInput) => void;
  broadcastConfigUpdate?: (
    event: Extract<AgentEvent, { type: "config_option_update" }>,
  ) => void;
}): Pick<TaskOps, "create"> {
  const { host, store, tasks } = deps;

  function authorize(principal: TaskCreateCaller): void {
    if (principal.kind !== "agent") return;
    if (principal.principal.generation === null) {
      throw new Error("execution_replaced");
    }
    if (
      !tasks.authority.accepts({
        taskId: principal.principal.taskId,
        generation: principal.principal.generation,
      })
    ) {
      throw new Error("execution_replaced");
    }
  }

  return {
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
        authorize(caller);
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
      const isRemote = target.host !== undefined;
      const result = await host.create({
        caller,
        input,
        target,
        parentId: localParentId,
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
      let taskTitle: string | undefined;
      let taskCreated:
        ReturnType<typeof buildTaskCreatedSystemMessage> | undefined;
      const prepareRecord = () => {
        if (caller.kind === "host" || !localParentId || !input.title) return;
        if (result.facts.title === null) {
          throw new Error("task_create_facts_incomplete");
        }
        taskTitle = result.facts.title;
        taskCreated = buildTaskCreatedSystemMessage({
          taskId: result.taskId,
          taskTitle,
          agentId: result.facts.agentId ?? "",
          host: isRemote ? target.host : undefined,
          cwd: result.facts.cwd,
          model: result.facts.model,
          thinking: result.facts.thinking,
        });
        if (target.host === undefined) {
          store.saveEvent(localParentId, "system_message", taskCreated.data, {
            from_ref: caller.kind === "agent" ? "agent" : "user",
          });
        }
      };
      if (target.host !== undefined) {
        const remoteHost = target.host;
        if (localParentId === undefined) throw new Error("parent_not_found");
        try {
          assertCaller();
          if (caller.kind === "user" && !store.getParentTask(localParentId)) {
            throw new Error("parent_not_found");
          }
          prepareRecord();
          if (taskCreated) {
            store.recordRemoteTaskChild(
              localParentId,
              result.taskId,
              remoteHost,
              {
                data: taskCreated.data,
                fromRef: caller.kind === "agent" ? "agent" : "user",
              },
            );
          } else {
            store.recordRemoteTaskChild(
              localParentId,
              result.taskId,
              remoteHost,
            );
          }
        } catch (error) {
          throw new TaskRemoteCreatePartialSuccessError(
            remoteHost,
            result.taskId,
            { cause: error },
          );
        }
      } else {
        assertCaller();
        prepareRecord();
      }
      if (taskCreated && taskTitle && localParentId) {
        deps.broadcastTaskCreated?.({
          messageId: randomUUID(),
          sourceTaskId: localParentId,
          targetTaskId: result.taskId,
          taskTitle,
          title: taskCreated.title,
          body: taskCreated.body,
        });
      }
      if (
        !isRemote &&
        caller.kind !== "agent" &&
        result.activation?.configOptions.length
      ) {
        deps.broadcastConfigUpdate?.({
          type: "config_option_update",
          taskId: result.taskId,
          configOptions: result.activation.configOptions,
        });
      }
      if (caller.kind === "agent") return { ...result, activation: undefined };
      if (isRemote && result.activation) {
        if (localParentId === undefined) throw new Error("parent_not_found");
        return {
          ...result,
          activation: {
            ...result.activation,
            parentId: localParentId,
            parentAgentId: store.getBindingAgent(localParentId) ?? null,
          },
        };
      }
      return result;
    },
  };
}
