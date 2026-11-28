import { isAbsolute, resolve } from "node:path";
import { AgentUnavailableError } from "../../agent-registry.ts";
import type { Store, TaskRow } from "../../store.ts";
import {
  isLocalCollaborationTarget,
  collaborationRelation,
} from "../../task-collaboration.ts";
import {
  TaskConfigOverrideError,
  type DeliveryBridge,
  type TaskManager,
} from "../../task-manager.ts";
import { expandHomePath } from "../../home-path.ts";
import { errorMessage } from "../../types.ts";
import { recordTaskCancelEvent } from "../../task-cancel-record.ts";
import { isoFromMillis, isoFromMillisOrNull } from "../../shared/time.ts";
import { formatSilence } from "../../obligation-controller.ts";
import { abbreviateHomePath } from "../../home-path.ts";
import type {
  TaskCaller,
  TaskCreateCaller,
  TaskQueryResult,
  TaskListItem,
  TaskOps,
  TaskReadResult,
  TaskCreateInput,
  TaskCreateResult,
} from "../../api/tasks.ts";
import {
  TaskAgentNotConfiguredError,
  TaskAgentStartError,
  TaskCreateConflictError,
  TaskCreateDeletedError,
  TaskCreateInputError,
  TaskCreateConfigError,
} from "../../api/tasks.ts";
import { opIdentity, TASK_CREATE_NAMESPACE } from "../../op-identity.ts";
import {
  buildTaskHistoryQuery,
  buildTaskHistoryRead,
  normalizeTaskHistoryRange,
  uniqueTaskHistorySeqs,
} from "../../task-history.ts";

export function assertTaskCaller(
  tasks: Pick<TaskManager, "authority">,
  principal: TaskCaller,
): void {
  if (principal.generation === null) throw new Error("execution_replaced");
  if (
    !tasks.authority.accepts({
      taskId: principal.taskId,
      generation: principal.generation,
    })
  ) {
    throw new Error("execution_replaced");
  }
}

/**
 * The one record of an agent-issued cancellation.
 *
 * It is a `system_message` row, the shape every task fact takes when it has a
 * place in the conversation: the machine fields (`sourceTaskId`, `reason`,
 * `status`) and the `kind` discriminator live in `data` beside a non-empty
 * title and a readable body. That is also the whole wire event, so live and
 * replay render through the generic system-message path without a dedicated
 * frontend branch. A user-initiated cancel stays deliberately different and
 * writes nothing here.
 */
function relationOrder(relation: TaskListItem["relation"]): number {
  return { self: 0, parent: 1, child: 2 }[relation];
}

function canonicalHistoryEvent(event: {
  task_id: string;
  seq: number;
  type: string;
  created_at: number;
  from_ref: string;
  data: string;
}) {
  return {
    ...event,
    created_at: isoFromMillis(event.created_at),
  };
}

export function createLocalTaskOps(deps: {
  store: Store;
  tasks: TaskManager;
  cancelTimeoutMs?: number;
}): TaskOps {
  const { store, tasks } = deps;

  /**
   * The single authority check for one MCP operation. It lives here because
   * the host is the only layer that has both the request's principal and the
   * execution authority, so there is exactly one implementation of "may this
   * caller still write?" and no wiring can silently drop it.
   *
   * The generation is the fence: a token names the generation it was promoted
   * for, and every binding change bumps the task's generation, so a moved
   * binding is already refused by `accepts`. The principal's `agentId` stays as
   * provenance — it says which agent the token came from, not what may write.
   *
   * Fail closed: a principal without a generation, or one whose generation is
   * no longer current, is refused.
   */
  function authorize(principal: TaskCaller): void {
    assertTaskCaller(tasks, principal);
  }

  function requireTask(taskId: string) {
    const task = store.getTask(taskId);
    if (!task) throw new Error("task_not_found");
    return task;
  }

  function requireLocalTarget(sourceTaskId: string, targetTaskId: string) {
    const source = requireTask(sourceTaskId);
    const target = requireTask(targetTaskId);
    if (!isLocalCollaborationTarget(source, target)) {
      throw new Error("target_not_allowed");
    }
    return { source, target };
  }

  function requireHistoryTarget(sourceTaskId: string, targetTaskId: string) {
    const source = store.getTask(sourceTaskId);
    const target = store.getTask(targetTaskId);
    if (
      !source ||
      !target ||
      (source.id !== target.id && !isLocalCollaborationTarget(source, target))
    ) {
      throw new Error("target_not_allowed");
    }
    return target;
  }

  function requireChildTarget(sourceTaskId: string, targetTaskId: string) {
    const source = requireTask(sourceTaskId);
    const target = requireTask(targetTaskId);
    if (target.parent_id !== source.id) {
      throw new Error("target_not_allowed");
    }
    return { source, target };
  }

  async function cancelExecution(taskId: string) {
    const bridge = tasks.hasAgentTurn(taskId)
      ? (tasks.existingTaskExecution(taskId)?.bridge ?? null)
      : null;
    return tasks.cancelTaskExecution(taskId, bridge, deps.cancelTimeoutMs ?? 0);
  }

  return {
    async list(principal) {
      authorize(principal);
      const source = requireTask(principal.taskId);
      // A task in an archived tree still needs its own row (relation: self)
      // and its local relatives, so both the active and archived reads are used.
      const entries = store
        .listTasks()
        .concat(store.listTasks({ archived: true }))
        .map((task) => ({
          task,
          relation: collaborationRelation(source, task),
        }))
        .filter(
          (
            entry,
          ): entry is {
            task: TaskRow;
            relation: TaskListItem["relation"];
          } => entry.relation !== null,
        )
        .sort(
          (a, b) =>
            relationOrder(a.relation) - relationOrder(b.relation) ||
            a.task.id.localeCompare(b.task.id),
        );
      const lastEventTimes = store.getLatestEventTimes(
        entries.map((entry) => entry.task.id),
      );
      return entries.map(({ task, relation }): TaskListItem => ({
        id: task.id,
        title: task.title ?? task.id,
        relation,
        workflowStatus: task.workflow_status,
        executionState: tasks.getExecutionState(task.id),
        lastAgentActivityAt: tasks.getLastAgentActivityAt(task.id),
        lastEventAt: isoFromMillisOrNull(lastEventTimes.get(task.id)),
      }));
    },

    async query(principal, input): Promise<TaskQueryResult> {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const targetId = input.taskId ?? sourceTaskId;
      const target = requireHistoryTarget(sourceTaskId, targetId);
      const maxSeq = store.getLastEventSeq(target.id);
      const [start, end] = normalizeTaskHistoryRange(input.range, maxSeq);
      const events =
        start > end
          ? []
          : store.getEvents(target.id, {
              afterSeq: start - 1,
              beforeSeq: end + 1,
            });
      return buildTaskHistoryQuery({
        taskId: target.id,
        events: events.map(canonicalHistoryEvent),
        maxSeq,
        range: input.range,
        text: input.text,
      });
    },

    async read(principal, input): Promise<TaskReadResult> {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const target = requireHistoryTarget(
        sourceTaskId,
        input.taskId ?? sourceTaskId,
      );
      const uniqueSeqs = uniqueTaskHistorySeqs(input.seqs);
      const events = uniqueSeqs.map((seq) => store.getEvent(target.id, seq));
      const missing = uniqueSeqs.filter((_, index) => !events[index]);
      if (missing.length > 0) {
        throw new Error(JSON.stringify({ error: "unknown_seq", missing }));
      }
      return buildTaskHistoryRead({
        taskId: target.id,
        events: events.map((event) => canonicalHistoryEvent(event!)),
        seqs: uniqueSeqs,
      });
    },

    // eslint-disable-next-line complexity -- one command owns both caller-specific target resolution and shared create effects.
    async create(
      caller: TaskCreateCaller,
      input: TaskCreateInput,
    ): Promise<TaskCreateResult> {
      if (caller.kind === "host") {
        const requestedAgent = input.agentId;
        if (requestedAgent === undefined) {
          throw new TaskAgentNotConfiguredError("");
        }
        if (!tasks.isAgentConfigured(requestedAgent)) {
          throw new TaskAgentNotConfiguredError(requestedAgent);
        }
        if (
          typeof input.parentId !== "string" ||
          input.parentId.trim() === ""
        ) {
          throw new TaskCreateInputError(
            "external_parent_required",
            "Host task creation requires a non-empty parentId",
          );
        }
        const effectiveSource = input.source ?? "host";
        const buildHostResult = (task: TaskRow): TaskCreateResult => ({
          task: {
            id: task.id,
            title: task.title,
            agentId: requestedAgent,
            cwd: task.cwd,
            model: task.model,
            thinking: task.reasoning_effort,
            parentId: task.parent_id,
            workflowStatus: task.workflow_status,
            source: task.source,
          },
          session: {
            cwdDisplay: abbreviateHomePath(task.cwd),
            parentAgentId: null,
            configOptions: [],
            agentCommands: tasks.getAgentCommands(task.id),
          },
        });
        const verifyReplay = (existing: TaskRow): TaskCreateResult => {
          if (existing.deleted_at !== null) {
            throw new TaskCreateDeletedError();
          }
          const link = store.getExternalParentLink(existing.id);
          const existingAgent = store.getBindingAgent(existing.id);
          if (
            link?.remote_host !== caller.name ||
            link.remote_task_id !== input.parentId ||
            existingAgent !== requestedAgent
          ) {
            throw new TaskCreateConflictError();
          }
          return buildHostResult(existing);
        };
        const deterministicId =
          input.opId !== null
            ? opIdentity(
                TASK_CREATE_NAMESPACE,
                `host:${caller.name}`,
                input.opId,
              )
            : undefined;
        if (deterministicId) {
          const existing = store.getTaskIncludingDeleted(deterministicId);
          if (existing) {
            return { ...verifyReplay(existing), replayed: true };
          }
        }
        try {
          const created = await tasks.createDeferredRemoteTask({
            id: deterministicId,
            agentId: requestedAgent,
            cwd: input.cwd,
            source: effectiveSource,
            externalParentId: input.parentId,
            remoteHost: caller.name,
            title: input.title,
            workflowStatus: input.workflowStatus,
          });
          return buildHostResult(requireTask(created.taskId));
        } catch (error) {
          if (deterministicId) {
            const raced = store.getTaskIncludingDeleted(deterministicId);
            if (raced) return { ...verifyReplay(raced), replayed: true };
          }
          throw error;
        }
      }
      const agentCaller = caller.kind === "agent" ? caller.principal : null;
      const source =
        agentCaller?.taskId !== undefined
          ? requireTask(agentCaller.taskId)
          : null;
      let effectiveParentId: string | undefined;
      if (!agentCaller) {
        effectiveParentId =
          input.parentId ??
          (store.getTaskIncludingDeleted(store.rootTaskId)
            ? store.rootTaskId
            : undefined);
        if (input.parentId && !store.getParentTask(input.parentId)) {
          throw new Error("parent_not_found");
        }
      }
      const localCallerScope =
        caller.kind === "agent"
          ? `agent:${caller.principal.taskId}`
          : `token:${caller.tokenName ?? "anonymous"}`;
      const localDeterministicId =
        input.opId !== null
          ? opIdentity(TASK_CREATE_NAMESPACE, localCallerScope, input.opId)
          : undefined;
      const expectedLocalParentId = agentCaller
        ? (input.parentId ?? agentCaller.taskId)
        : (effectiveParentId ?? null);
      const effectiveLocalSource =
        input.source ?? (agentCaller ? "agent" : "auto");
      const verifyLocalReplay = (existing: TaskRow): TaskCreateResult => {
        if (existing.deleted_at !== null) {
          throw new TaskCreateDeletedError();
        }
        const existingAgent =
          store.getBindingAgent(existing.id) ?? tasks.defaultAgentId;
        if (
          existing.parent_id !== expectedLocalParentId ||
          (input.agentId !== undefined && existingAgent !== input.agentId)
        ) {
          throw new TaskCreateConflictError();
        }
        const parentAgentId =
          existing.parent_id !== null
            ? (store.getBindingAgent(existing.parent_id) ?? null)
            : null;
        return {
          replayed: true,
          task: {
            id: existing.id,
            title: existing.title,
            agentId: existingAgent,
            cwd: existing.cwd,
            model: existing.model,
            thinking: existing.reasoning_effort,
            parentId: existing.parent_id,
            workflowStatus: existing.workflow_status,
            source: existing.source,
          },
          session: {
            cwdDisplay: abbreviateHomePath(existing.cwd),
            parentAgentId,
            configOptions: tasks.configOptionsForTask(existing.id),
            agentCommands: tasks.getAgentCommands(existing.id),
          },
        };
      };
      if (localDeterministicId) {
        const existing = store.getTaskIncludingDeleted(localDeterministicId);
        if (existing) return verifyLocalReplay(existing);
      }
      const requestedAgent = input.agentId;
      let targetAgentId: string;
      let targetBridge: DeliveryBridge;
      if (requestedAgent !== undefined) {
        if (!tasks.isAgentConfigured(requestedAgent)) {
          throw new TaskAgentNotConfiguredError(requestedAgent);
        }
        try {
          targetBridge = await tasks.resolveAgentTransport(requestedAgent);
        } catch (error) {
          throw new TaskAgentStartError(
            requestedAgent,
            errorMessage(error),
            error instanceof AgentUnavailableError ? true : false,
            {
              cause: error,
            },
          );
        }
        targetAgentId = requestedAgent;
      } else if (source && agentCaller) {
        const execution = await tasks.resolveTaskExecution(source.id);
        targetBridge = execution.bridge;
        targetAgentId = execution.agentId;
      } else {
        const parentAgent = effectiveParentId
          ? store.getBindingAgent(effectiveParentId)
          : undefined;
        targetAgentId =
          parentAgent && tasks.isAgentConfigured(parentAgent)
            ? parentAgent
            : tasks.defaultAgentId;
        try {
          targetBridge = await tasks.resolveAgentTransport(targetAgentId);
        } catch (error) {
          throw new TaskAgentStartError(
            targetAgentId,
            errorMessage(error),
            error instanceof AgentUnavailableError ? true : false,
            { cause: error },
          );
        }
      }
      // The resolution above awaited; the caller must still own its execution
      // before anything is created.
      if (agentCaller) authorize(agentCaller);
      const cwd =
        source && agentCaller
          ? (() => {
              const requestedCwd = input.cwd
                ? expandHomePath(input.cwd)
                : source.cwd;
              return isAbsolute(requestedCwd)
                ? requestedCwd
                : resolve(source.cwd, requestedCwd);
            })()
          : input.cwd;
      let created: Awaited<ReturnType<TaskManager["createTask"]>>;
      try {
        created = await tasks.createTask(
          targetBridge,
          cwd,
          input.inheritFromTaskId,
          effectiveLocalSource,
          {
            ...(localDeterministicId === undefined
              ? {}
              : { id: localDeterministicId }),
            parentId: input.parentId,
            title: input.title,
            model: input.model,
            thinking: input.thinking,
            ...(input.workflowStatus === undefined
              ? {}
              : { workflowStatus: input.workflowStatus }),
            // Only a caller-chosen target is declared here: inheritance keeps
            // the parent-binding assertion in `createTask`, which is the guard
            // that refuses a silently different execution environment.
            ...(requestedAgent === undefined ? {} : { agentId: targetAgentId }),
            // Third boundary: the task is persisted only while the caller still
            // owns its execution. `newSession` and the tree lock are awaits, and
            // a rotation can land inside either of them.
            ...(agentCaller
              ? {
                  assertCaller: () => {
                    authorize(agentCaller);
                  },
                }
              : {}),
            ...(input.opId === null ? {} : { clientOpId: input.opId }),
          },
        );
      } catch (error) {
        if (localDeterministicId) {
          const raced = store.getTaskIncludingDeleted(localDeterministicId);
          if (raced) return verifyLocalReplay(raced);
        }
        // The target's own schema refused a requested value. The candidates
        // must be this session's, so they travel on the error rather than
        // being looked up in the agent-level cache after the fact.
        if (error instanceof TaskConfigOverrideError) {
          throw new TaskCreateConfigError(
            { ...error, agentId: targetAgentId },
            { cause: error },
          );
        }
        throw error;
      }
      if (agentCaller) authorize(agentCaller);
      const taskFacts = created.facts;
      return {
        task: {
          id: created.taskId,
          title: taskFacts.title,
          agentId: taskFacts.agentId,
          cwd: agentCaller ? (cwd ?? taskFacts.cwd) : taskFacts.cwd,
          model: taskFacts.model,
          thinking: taskFacts.thinking,
          parentId: taskFacts.parentId,
          workflowStatus: taskFacts.workflowStatus,
          source: taskFacts.source,
        },
        ...(!agentCaller
          ? {
              session: {
                cwdDisplay: abbreviateHomePath(taskFacts.cwd),
                parentAgentId:
                  taskFacts.parentId !== null
                    ? (store.getBindingAgent(taskFacts.parentId) ?? null)
                    : null,
                configOptions: created.configOptions,
                agentCommands: tasks.getAgentCommands(created.taskId),
              },
            }
          : {}),
      };
    },

    async cancel(command) {
      if (command.kind !== "agent") {
        const result = await cancelExecution(command.taskId);
        if (command.kind === "host" && command.actor.kind === "agent") {
          const targetTask = store.getTaskIncludingDeleted(command.taskId);
          recordTaskCancelEvent({
            store,
            role: "target",
            sourceTaskId: command.actor.sourceTaskId,
            sourceLabel: command.actor.sourceLabel,
            targetTaskId: command.taskId,
            targetLabel: targetTask?.title ?? command.taskId.slice(0, 8),
            reason: command.actor.reason,
            status: result.status,
          });
        }
        return {
          accepted: true,
          taskId: command.taskId,
          status: result.status,
        };
      }

      authorize(command.principal);
      const sourceTaskId = command.principal.taskId;
      const { target } = requireChildTarget(sourceTaskId, command.targetTaskId);
      const result = await cancelExecution(target.id);
      // The cancel awaited a transport round trip; the record of what happened
      // is only written while the caller still owns its execution.
      authorize(command.principal);
      const sourceTask = store.getTaskIncludingDeleted(sourceTaskId);
      const targetTask = store.getTaskIncludingDeleted(target.id);
      const sourceLabel = sourceTask?.title ?? sourceTaskId.slice(0, 8);
      const targetLabel = targetTask?.title ?? target.id.slice(0, 8);
      for (const role of ["source", "target"] as const) {
        recordTaskCancelEvent({
          store,
          role,
          sourceTaskId,
          sourceLabel,
          targetTaskId: target.id,
          targetLabel,
          reason: command.reason,
          status: result.status,
        });
      }
      return { accepted: true, taskId: target.id, status: result.status };
    },

    async send(principal, targetTaskId, body, record) {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const { source, target } = requireLocalTarget(sourceTaskId, targetTaskId);
      const targetLabel = target.title ?? target.id.slice(0, 8);
      const result = {
        messageId: "",
        deliveryId: "",
        targetTaskId: target.id,
        targetLabel,
        sourceLabel: source.title ?? source.id.slice(0, 8),
      };
      const created = store.enqueueTargetCollaboration(
        {
          sourceTaskId,
          targetTaskId: target.id,
          body,
        },
        ({ messageId, deliveryId }) => {
          result.messageId = messageId;
          result.deliveryId = deliveryId;
          record?.(result);
        },
      );
      result.messageId = created.messageId;
      result.deliveryId = created.deliveryId;
      return result;
    },

    async update(principal, status, body, recordReport) {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      // `waiting` only records the status. `done` and `blocked` settle the
      // target's open account and are delivered to its source, or fall back to
      // the current parent when no account is open.
      const { silenceWatchMs } = tasks.settleAgentUpdate(
        sourceTaskId,
        status,
        body,
        ({ targetTaskId, targetIsLocal }) => {
          if (status === "waiting") return;
          recordReport?.({
            sourceTaskId,
            targetTaskId,
            targetIsLocal,
            status,
            body,
            sourceLabel:
              store.getTask(sourceTaskId)?.title ?? sourceTaskId.slice(0, 8),
            targetLabel: targetIsLocal
              ? (store.getTask(targetTaskId)?.title ?? targetTaskId.slice(0, 8))
              : targetTaskId.slice(0, 8),
          });
        },
      );
      if (silenceWatchMs === undefined) return {};
      return {
        note: `No visible wake source; the requester is notified after ${formatSilence(silenceWatchMs)} without agent activity.`,
      };
    },
  };
}
