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
import { TaskAgentIdTypeError, TaskCreateInputError } from "./api/tasks.ts";

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
      return host.create({
        caller,
        input,
        target,
        parentId: localParentId,
        assertRemoteCaller: () => {
          if (
            caller.kind === "user" &&
            (!localParentId || !store.getParentTask(localParentId))
          ) {
            throw new Error("parent_not_found");
          }
        },
        completeRemote: (result, remoteHost) => {
          const remoteParentId = localParentId;
          if (remoteParentId === undefined) {
            throw new Error("parent_not_found");
          }
          authorize(caller);
          if (caller.kind === "user" && !store.getParentTask(remoteParentId)) {
            throw new Error("parent_not_found");
          }
          store.recordRemoteTaskChild(
            remoteParentId,
            result.taskId,
            remoteHost,
          );
          if (caller.kind === "agent") return { taskId: result.taskId };
          if (!result.activation) {
            throw new Error("missing_remote_create_activation");
          }
          return {
            taskId: result.taskId,
            activation: {
              ...result.activation,
              parentId: remoteParentId,
              parentAgentId: store.getBindingAgent(remoteParentId) ?? null,
            },
          };
        },
      });
    },
  };
}
