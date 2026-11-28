import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { AgentUnavailableError } from "../../agent-registry.ts";
import type { Store, TaskRow } from "../../store.ts";
import { collaborationRelation } from "../../task-collaboration.ts";
import {
  TaskConfigOverrideError,
  type DeliveryBridge,
  type TaskManager,
} from "../../task-manager.ts";
import { expandHomePath, abbreviateHomePath } from "../../home-path.ts";
import { errorMessage } from "../../types.ts";
import { isoFromMillis, isoFromMillisOrNull } from "../../shared/time.ts";
import type {
  AgentCaller,
  Caller,
  TaskCancelOutcome,
  TaskQueryInput,
  TaskQueryResult,
  TaskListItem,
  TaskReadInput,
  TaskReadResult,
  TaskCreateInput,
  TaskCreateResult,
  TaskSendResult,
} from "../../api/tasks.ts";
import {
  TaskAgentNotConfiguredError,
  TaskAgentStartError,
  TaskCreateConflictError,
  TaskCreateDeletedError,
  TaskCreateInputError,
  TaskCreateConfigError,
} from "../../api/tasks.ts";
import type {
  LocalTaskRelationFact,
  SendLabels,
  TaskHistoryHostCommand,
  TaskReportDelivery,
  TaskReportDeliveryResult,
} from "../api.ts";
import { opIdentity, TASK_CREATE_NAMESPACE } from "../../op-identity.ts";
import {
  buildTaskHistoryQuery,
  buildTaskHistoryRead,
  normalizeTaskHistoryRange,
  uniqueTaskHistorySeqs,
} from "../../task-history.ts";

export interface LocalTaskHost {
  list(principal: AgentCaller): Promise<TaskListItem[]>;
  query(
    command: TaskHistoryHostCommand<TaskQueryInput>,
  ): Promise<TaskQueryResult>;
  read(command: TaskHistoryHostCommand<TaskReadInput>): Promise<TaskReadResult>;
  create(
    caller: Caller,
    input: TaskCreateInput,
    assertCaller?: () => void,
  ): Promise<{ replayed: boolean; result: TaskCreateResult }>;
  cancel(taskId: string): Promise<TaskCancelOutcome["status"]>;
  send(
    principal: AgentCaller,
    targetTaskId: string,
    body: string,
    prepareLocalSend: (
      source: LocalTaskRelationFact | undefined,
      target: LocalTaskRelationFact | undefined,
    ) => SendLabels,
    record: (performed: TaskSendResult) => void,
  ): Promise<TaskSendResult>;
  deliverReport(report: TaskReportDelivery): TaskReportDeliveryResult;
}

function toRelationFact(
  task: TaskRow | undefined,
): LocalTaskRelationFact | undefined {
  return task
    ? { id: task.id, parentId: task.parent_id, title: task.title }
    : undefined;
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

export function createLocalTaskHost(deps: {
  store: Store;
  tasks: TaskManager;
  cancelTimeoutMs?: number;
}): LocalTaskHost {
  const { store, tasks } = deps;

  function requireTask(taskId: string) {
    const task = store.getTask(taskId);
    if (!task) throw new Error("task_not_found");
    return task;
  }

  async function cancelExecution(taskId: string) {
    const bridge = tasks.hasAgentTurn(taskId)
      ? (tasks.existingTaskExecution(taskId)?.bridge ?? null)
      : null;
    return tasks.cancelTaskExecution(taskId, bridge, deps.cancelTimeoutMs ?? 0);
  }

  return {
    async list(principal) {
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

    async query(command): Promise<TaskQueryResult> {
      const { principal, input, assertLocalTarget } = command;
      const sourceTaskId = principal.taskId;
      const targetId = input.taskId ?? sourceTaskId;
      const source = store.getTask(sourceTaskId);
      const target = store.getTask(targetId);
      assertLocalTarget(toRelationFact(source), toRelationFact(target));
      const resolvedTargetId = target!.id;
      const maxSeq = store.getLastEventSeq(resolvedTargetId);
      const [start, end] = normalizeTaskHistoryRange(input.range, maxSeq);
      const events =
        start > end
          ? []
          : store.getEvents(resolvedTargetId, {
              afterSeq: start - 1,
              beforeSeq: end + 1,
            });
      return buildTaskHistoryQuery({
        taskId: resolvedTargetId,
        events: events.map(canonicalHistoryEvent),
        maxSeq,
        range: input.range,
        text: input.text,
      });
    },

    async read(command): Promise<TaskReadResult> {
      const { principal, input, assertLocalTarget } = command;
      const sourceTaskId = principal.taskId;
      const targetId = input.taskId ?? sourceTaskId;
      const source = store.getTask(sourceTaskId);
      const target = store.getTask(targetId);
      assertLocalTarget(toRelationFact(source), toRelationFact(target));
      const resolvedTargetId = target!.id;
      const uniqueSeqs = uniqueTaskHistorySeqs(input.seqs);
      const events = uniqueSeqs.map((seq) =>
        store.getEvent(resolvedTargetId, seq),
      );
      const missing = uniqueSeqs.filter((_, index) => !events[index]);
      if (missing.length > 0) {
        throw new Error(JSON.stringify({ error: "unknown_seq", missing }));
      }
      return buildTaskHistoryRead({
        taskId: resolvedTargetId,
        events: events.map((event) => canonicalHistoryEvent(event!)),
        seqs: uniqueSeqs,
      });
    },

    // eslint-disable-next-line complexity -- one command owns both caller-specific target resolution and shared create effects.
    async create(
      caller: Caller,
      input: TaskCreateInput,
      assertCaller?: () => void,
    ): Promise<{ replayed: boolean; result: TaskCreateResult }> {
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
            return { replayed: true, result: verifyReplay(existing) };
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
          return {
            replayed: false,
            result: buildHostResult(requireTask(created.taskId)),
          };
        } catch (error) {
          if (deterministicId) {
            const raced = store.getTaskIncludingDeleted(deterministicId);
            if (raced) return { replayed: true, result: verifyReplay(raced) };
          }
          throw error;
        }
      }
      const agentCaller = caller.kind === "agent" ? caller : null;
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
          ? `agent:${caller.taskId}`
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
      const verifyLocalReplay = (
        existing: TaskRow,
      ): { replayed: true; result: TaskCreateResult } => {
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
          result: {
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
      if (agentCaller) assertCaller?.();
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
            ...(agentCaller && assertCaller ? { assertCaller } : {}),
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
      if (agentCaller) assertCaller?.();
      const taskFacts = created.facts;
      return {
        replayed: false,
        result: {
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
        },
      };
    },

    async cancel(taskId) {
      const result = await cancelExecution(taskId);
      return result.status;
    },

    async send(principal, targetTaskId, body, prepareLocalSend, record) {
      const sourceTaskId = principal.taskId;
      const source = store.getTask(sourceTaskId);
      const target = store.getTask(targetTaskId);
      const { sourceLabel, targetLabel } = prepareLocalSend(
        toRelationFact(source),
        toRelationFact(target),
      );
      const resolvedTargetId = target!.id;
      const result = {
        messageId: "",
        deliveryId: "",
        targetTaskId: resolvedTargetId,
        targetLabel,
        sourceLabel,
      };
      const created = store.enqueueTargetCollaboration(
        {
          sourceTaskId,
          targetTaskId: resolvedTargetId,
          body,
        },
        ({ messageId, deliveryId }) => {
          result.messageId = messageId;
          result.deliveryId = deliveryId;
          record(result);
        },
      );
      result.messageId = created.messageId;
      result.deliveryId = created.deliveryId;
      return result;
    },

    deliverReport(report) {
      const messageId = randomUUID();
      const deliveryId = randomUUID();
      if (
        !store.enqueueReportDelivery({
          id: messageId,
          deliveryId,
          idempotencyKey: `${messageId}:${report.targetTaskId}`,
          sourceTaskId: report.sourceTaskId,
          targetTaskId: report.targetTaskId,
          body: report.body,
        })
      ) {
        return {};
      }
      report.recordLocalReport({ messageId, deliveryId });
      return { drainLocalTargetTaskId: report.targetTaskId };
    },
  };
}
