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
import { buildTaskCreatedSystemMessage } from "./task-created-message.ts";
import { randomUUID } from "node:crypto";

function parseTarget(
  caller: TaskCreateCaller,
  agentId: string | undefined,
): TaskCreateTarget {
  if (!agentId?.includes("@")) return { agentId };
  const at = agentId.indexOf("@");
  if (at <= 0 || at !== agentId.lastIndexOf("@") || at === agentId.length - 1) {
    throw new TaskCreateInputError(
      "invalid_remote_agent",
      "Invalid agent@host target",
    );
  }
  if (caller.kind === "host") {
    throw new TaskCreateInputError(
      "invalid_remote_agent",
      "Host credentials cannot relay an agent@host target",
    );
  }
  return {
    agentId: agentId.slice(0, at),
    host: agentId.slice(at + 1),
  };
}

export function createTaskOpsCore(deps: {
  host: TaskCreateHost;
  store: Store;
  tasks: TaskManager;
  broadcastTaskCreated?: (event: {
    messageId: string;
    sourceTaskId: string;
    targetTaskId: string;
    taskTitle: string;
    title: string;
    body: string;
  }) => void;
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
      const requestedAgent = input.agentId;
      if (requestedAgent !== undefined && typeof requestedAgent !== "string") {
        throw new TaskAgentIdTypeError();
      }

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
      const target = parseTarget(caller, requestedAgent);
      // Location selection belongs below this port. Core calls it once with a
      // structured coordinate; completion callbacks are the narrow write-back
      // path for accepted work whose owner is another instance.
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
      const isRemote = target.host !== undefined;
      if (isRemote) {
        const remoteParentId = localParentId;
        if (remoteParentId === undefined) throw new Error("parent_not_found");
        try {
          authorize(caller);
          if (caller.kind === "user" && !store.getParentTask(remoteParentId)) {
            throw new Error("parent_not_found");
          }
          store.recordRemoteTaskChild(
            remoteParentId,
            result.taskId,
            target.host!,
          );
        } catch (error) {
          throw new TaskRemoteCreatePartialSuccessError(
            target.host!,
            result.taskId,
            { cause: error },
          );
        }
      }
      if (
        caller.kind !== "host" &&
        localParentId !== undefined &&
        input.title &&
        result.facts
      ) {
        authorize(caller);
        const taskCreated = buildTaskCreatedSystemMessage({
          taskId: result.taskId,
          taskTitle: input.title,
          agentId: result.facts.agentId
            ? `${result.facts.agentId}${isRemote ? `@${target.host}` : ""}`
            : "",
          cwd: result.facts.cwd,
          model: result.facts.model,
          thinking: result.facts.thinking,
        });
        store.saveEvent(localParentId, "system_message", taskCreated.data, {
          from_ref: caller.kind === "agent" ? "agent" : "user",
        });
        deps.broadcastTaskCreated?.({
          messageId: randomUUID(),
          sourceTaskId: localParentId,
          targetTaskId: result.taskId,
          taskTitle: input.title,
          title: taskCreated.title,
          body: taskCreated.body,
        });
      }
      if (caller.kind === "agent") return { ...result, activation: undefined };
      if (isRemote && result.activation) {
        return {
          ...result,
          activation: {
            ...result.activation,
            parentId: localParentId!,
            parentAgentId: store.getBindingAgent(localParentId!) ?? null,
          },
        };
      }
      return result;
    },
  };
}
