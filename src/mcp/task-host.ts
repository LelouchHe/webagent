import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Store, TaskRow } from "../store.ts";
import {
  isLocalCollaborationTarget,
  collaborationRelation,
} from "../task-collaboration.ts";
import {
  TaskConfigOverrideError,
  reportedExecutionConfig,
  type DeliveryBridge,
  type TaskManager,
} from "../task-manager.ts";
import { expandHomePath } from "../home-path.ts";
import { errorMessage, type AgentEvent } from "../types.ts";
import { formatFieldBlock } from "../shared/field-block.ts";
import { formatTaskReference } from "../shared/task-reference.ts";
import { isoFromMillis, isoFromMillisOrNull } from "../shared/time.ts";
import { buildTaskCreatedSystemMessage } from "../task-created-message.ts";
import type {
  McpCallerPrincipal,
  McpTaskQueryResult,
  McpTaskListItem,
  McpTaskToolHost,
  McpTaskReadResult,
  McpTaskCreateInput,
  McpTaskCreateResult,
} from "./tools.ts";
import {
  parseTaskHistoryData,
  projectTaskHistoryRow,
  TASK_HISTORY_LIMITS,
} from "./task-history.ts";
import {
  agentStartError,
  configOverrideError,
  unconfiguredAgentError,
} from "./create-errors.ts";

const {
  queryBytes: QUERY_LIMIT_BYTES,
  readBytes: READ_LIMIT_BYTES,
  readSingleBytes: READ_SINGLE_LIMIT_BYTES,
  readSeqs: MAX_READ_SEQS,
} = TASK_HISTORY_LIMITS;

export interface McpTaskCollaborationEvent {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  title: string;
  body: string;
}

export interface McpTaskCreatedEvent {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  title: string;
  body: string;
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
export type McpTaskCancelNotice = Extract<
  AgentEvent,
  { type: "system_message" }
>;

function relationOrder(relation: McpTaskListItem["relation"]): number {
  return { self: 0, parent: 1, child: 2, sibling: 3 }[relation];
}

export function createMcpTaskToolHost(deps: {
  store: Store;
  tasks: TaskManager;
  cancelTimeoutMs?: number;
  broadcastCollaboration?: (event: McpTaskCollaborationEvent) => void;
  broadcastTaskCreated?: (event: McpTaskCreatedEvent) => void;
  broadcastTaskCancelNotice?: (event: McpTaskCancelNotice) => void;
}): McpTaskToolHost {
  const {
    store,
    tasks,
    broadcastCollaboration,
    broadcastTaskCreated,
    broadcastTaskCancelNotice,
  } = deps;

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
  function authorize(principal: McpCallerPrincipal): void {
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

  function responseTooLarge(
    value: unknown,
    limitBytes: number,
    extra: Record<string, unknown>,
  ): never {
    const requiredBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    throw new Error(
      JSON.stringify({
        error: "response_too_large",
        required_bytes: requiredBytes,
        limit_bytes: limitBytes,
        ...extra,
      }),
    );
  }

  function normalizeRange(
    range: [number, number] | undefined,
    maxSeq: number,
  ): [number, number] {
    if (maxSeq < 1) return [1, 0];
    const resolveIndex = (value: number) =>
      value < 0 ? maxSeq + value + 1 : value;
    const clamp = (value: number) => Math.min(maxSeq, Math.max(1, value));
    const a = clamp(resolveIndex(range?.[0] ?? 1));
    const b = clamp(resolveIndex(range?.[1] ?? maxSeq));
    return a <= b ? [a, b] : [b, a];
  }

  function requireChildTarget(sourceTaskId: string, targetTaskId: string) {
    const source = requireTask(sourceTaskId);
    const target = requireTask(targetTaskId);
    if (target.parent_id !== source.id) {
      throw new Error("target_not_allowed");
    }
    return { source, target };
  }

  return {
    list(principal) {
      authorize(principal);
      const source = requireTask(principal.taskId);
      const entries = store
        .listTasks()
        .map((task) => ({
          task,
          relation: collaborationRelation(source, task),
        }))
        .filter(
          (
            entry,
          ): entry is {
            task: TaskRow;
            relation: McpTaskListItem["relation"];
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
      return entries.map(
        ({ task, relation }): McpTaskListItem => ({
          id: task.id,
          title: task.title ?? task.id,
          relation,
          workflowStatus: task.workflow_status,
          executionState: tasks.getExecutionState(task.id),
          lastAgentActivityAt: tasks.getLastAgentActivityAt(task.id),
          lastEventAt: isoFromMillisOrNull(lastEventTimes.get(task.id)),
        }),
      );
    },

    query(principal, input): McpTaskQueryResult {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const targetId = input.taskId ?? sourceTaskId;
      const target = requireHistoryTarget(sourceTaskId, targetId);
      const maxSeq = store.getLastEventSeq(target.id);
      const [start, end] = normalizeRange(input.range, maxSeq);
      const events =
        start > end
          ? []
          : store.getEvents(target.id, {
              afterSeq: start - 1,
              beforeSeq: end + 1,
            });
      const rows = events
        .map((event) => projectTaskHistoryRow(event, input.text))
        .filter((row) => input.text === undefined || row.field !== undefined);
      const result: McpTaskQueryResult = {
        task_id: target.id,
        max_seq: maxSeq,
        rows,
      };
      const requiredBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (requiredBytes > QUERY_LIMIT_BYTES) {
        responseTooLarge(result, QUERY_LIMIT_BYTES, {
          max_seq: maxSeq,
          hint: { range: [-Math.min(50, maxSeq), -1] },
        });
      }
      return result;
    },

    read(principal, input): McpTaskReadResult {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const target = requireHistoryTarget(
        sourceTaskId,
        input.taskId ?? sourceTaskId,
      );
      const uniqueSeqs = [...new Set(input.seqs)].sort((a, b) => a - b);
      if (uniqueSeqs.length > MAX_READ_SEQS && uniqueSeqs.length !== 1) {
        throw new Error(`too_many_seqs: maximum is ${MAX_READ_SEQS}`);
      }
      const events = uniqueSeqs.map((seq) => store.getEvent(target.id, seq));
      const missing = uniqueSeqs.filter((_, index) => !events[index]);
      if (missing.length > 0) {
        throw new Error(JSON.stringify({ error: "unknown_seq", missing }));
      }
      const rows = events.map((event) => ({
        seq: event!.seq,
        type: event!.type,
        at: isoFromMillis(event!.created_at),
        from: event!.from_ref,
        data: parseTaskHistoryData(event!.data),
      }));
      const result: McpTaskReadResult = { task_id: target.id, rows };
      // A single-seq request is exempt from the batch byte budget so one
      // legitimate event is never permanently unreadable.
      const limitBytes =
        uniqueSeqs.length === 1 ? READ_SINGLE_LIMIT_BYTES : READ_LIMIT_BYTES;
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > limitBytes) {
        responseTooLarge(result, limitBytes, { seqs: uniqueSeqs });
      }
      return result;
    },

    async create(
      principal: McpCallerPrincipal,
      input: McpTaskCreateInput,
    ): Promise<McpTaskCreateResult> {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      // The child runs where the caller says, or — when it says nothing — in
      // the source task's execution environment. Only an explicit `agent` may
      // diverge from the caller's binding, and it is resolved *before* anything
      // is created so an unusable target leaves no trace.
      const requestedAgent = input.agent;
      let targetAgentId: string;
      let targetBridge: DeliveryBridge;
      if (requestedAgent !== undefined) {
        if (!tasks.isAgentConfigured(requestedAgent)) {
          throw new Error(unconfiguredAgentError(requestedAgent));
        }
        try {
          targetBridge = await tasks.resolveAgentTransport(requestedAgent);
        } catch (error) {
          throw new Error(
            agentStartError(requestedAgent, errorMessage(error)),
            {
              cause: error,
            },
          );
        }
        targetAgentId = requestedAgent;
      } else {
        const execution = await tasks.resolveTaskExecution(sourceTaskId);
        targetBridge = execution.bridge;
        targetAgentId = execution.agentId;
      }
      // The resolution above awaited; the caller must still own its execution
      // before anything is created.
      authorize(principal);
      const source = requireTask(sourceTaskId);
      const requestedCwd = input.cwd ? expandHomePath(input.cwd) : source.cwd;
      const cwd = isAbsolute(requestedCwd)
        ? requestedCwd
        : resolve(source.cwd, requestedCwd);
      let created: Awaited<ReturnType<TaskManager["createTask"]>>;
      try {
        created = await tasks.createTask(
          targetBridge,
          cwd,
          source.id,
          "agent",
          {
            parentId: source.id,
            title: input.title,
            model: input.model,
            thinking: input.thinking,
            // Only a caller-chosen target is declared here: inheritance keeps
            // the parent-binding assertion in `createTask`, which is the guard
            // that refuses a silently different execution environment.
            ...(requestedAgent === undefined ? {} : { agentId: targetAgentId }),
            // Third boundary: the task is persisted only while the caller still
            // owns its execution. `newSession` and the tree lock are awaits, and
            // a rotation can land inside either of them.
            assertCaller: () => {
              authorize(principal);
            },
          },
        );
      } catch (error) {
        // The target's own schema refused a requested value. The candidates
        // must be this session's, so they travel on the error rather than
        // being looked up in the agent-level cache after the fact.
        if (error instanceof TaskConfigOverrideError) {
          throw new Error(
            configOverrideError({ ...error, agentId: targetAgentId }),
            { cause: error },
          );
        }
        throw error;
      }
      // The child is committed and stays: it was created while the caller
      // still owned its execution. This last step writes into the *source*
      // transcript and broadcasts, and `createTask` may have awaited source
      // config inheritance since the persist boundary — so the caller is
      // validated again immediately before the source-side commit, with no
      // await in between.
      authorize(principal);
      const reported = reportedExecutionConfig(created.configOptions);
      const taskCreatedMessageId = randomUUID();
      const taskCreated = buildTaskCreatedSystemMessage({
        taskId: created.taskId,
        taskTitle: input.title,
        agentId: store.getBindingAgent(created.taskId) ?? targetAgentId,
        cwd,
        // What took effect, not what was asked: an explicit value that the
        // target accepted, the value inherited from a same-agent source, or
        // the target session's own current value.
        model: input.model ?? reported.model ?? null,
        thinking: input.thinking ?? reported.reasoning_effort ?? null,
      });
      store.saveEvent(source.id, "system_message", taskCreated.data, {
        from_ref: "agent",
      });
      broadcastTaskCreated?.({
        messageId: taskCreatedMessageId,
        sourceTaskId: source.id,
        targetTaskId: created.taskId,
        title: taskCreated.title,
        body: taskCreated.body,
      });
      return { taskId: created.taskId };
    },

    async cancel(principal, targetTaskId, reason) {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const { target } = requireChildTarget(sourceTaskId, targetTaskId);
      const bridge = tasks.existingTaskExecution(target.id)?.bridge ?? null;
      const result = await tasks.cancelTaskExecution(
        target.id,
        bridge,
        deps.cancelTimeoutMs ?? 0,
      );
      // The cancel awaited a transport round trip; the record of what happened
      // is only written while the caller still owns its execution.
      authorize(principal);
      // One fact, two rows, one per side of the edge: the canceller reads it as
      // an act, the cancelled task as something done to it. Both are ordinary
      // `system_message` rows (machine fields in `data`), so each side renders
      // through the generic path and neither title is ever empty. Titles come
      // from the live task rows, with the same short-id fallback collaboration
      // uses; a cancelled task may already be soft-deleted, hence
      // `getTaskIncludingDeleted`.
      const sourceTask = store.getTaskIncludingDeleted(sourceTaskId);
      const targetTask = store.getTaskIncludingDeleted(target.id);
      const sourceLabel = formatTaskReference(
        sourceTask?.title ?? sourceTaskId.slice(0, 8),
      );
      const targetLabel = formatTaskReference(
        targetTask?.title ?? target.id.slice(0, 8),
      );
      const body = formatFieldBlock([
        { label: "reason", value: reason },
        { label: "status", value: result.status },
      ]);
      const rows = [
        {
          taskId: sourceTaskId,
          role: "source" as const,
          title: `${sourceLabel} cancelled ${targetLabel}`,
        },
        {
          taskId: target.id,
          role: "target" as const,
          title: `Cancelled by ${sourceLabel}`,
        },
      ];
      for (const row of rows) {
        store.saveEvent(
          row.taskId,
          "system_message",
          {
            kind: "task_cancel",
            role: row.role,
            sourceTaskId,
            targetTaskId: target.id,
            reason,
            status: result.status,
            title: row.title,
            body,
          },
          { from_ref: "agent" },
        );
        broadcastTaskCancelNotice?.({
          type: "system_message",
          taskId: row.taskId,
          kind: "task_cancel",
          role: row.role,
          sourceTaskId,
          targetTaskId: target.id,
          title: row.title,
          body,
        });
      }
      return { accepted: true, taskId: target.id, status: result.status };
    },

    async send(principal, targetTaskId, body) {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const { source, target } = requireLocalTarget(sourceTaskId, targetTaskId);
      const created = store.createCollaborationMessage({
        id: randomUUID(),
        deliveryId: randomUUID(),
        sourceTaskId,
        directTargetTaskId: target.id,
        sourceActor: "agent",
        body,
      });
      const sourceLabel = source.title ?? source.id.slice(0, 8);
      const targetLabel = target.title ?? target.id.slice(0, 8);
      broadcastCollaboration?.({
        messageId: created.message.id,
        sourceTaskId,
        targetTaskId: target.id,
        title: `${formatTaskReference(sourceLabel)} sent ${formatTaskReference(targetLabel)}`,
        body: created.message.body,
      });
      void tasks.drainCollaborationDeliveries(target.id);
    },

    async update(principal, status, body) {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      // The controller decides whether this update settles the target's sole
      // record (eligible current turn) or is only routed: to the stored source
      // when a record exists, or to the current parent when none does.
      const activeTurn = tasks.getActiveAgentTurn(sourceTaskId);
      const routed = tasks.settleAgentUpdate(
        sourceTaskId,
        status,
        body,
        activeTurn,
      );
      const { collaborationMessageId, accountTargetTaskId } = routed;
      if (collaborationMessageId && accountTargetTaskId) {
        const source = requireTask(sourceTaskId);
        const target = requireTask(accountTargetTaskId);
        broadcastCollaboration?.({
          messageId: collaborationMessageId,
          sourceTaskId,
          targetTaskId: accountTargetTaskId,
          title: `${formatTaskReference(source.title ?? source.id.slice(0, 8))} sent ${formatTaskReference(target.title ?? target.id.slice(0, 8))}`,
          body: `Task status: ${status}\n${body}`,
        });
        void tasks.drainCollaborationDeliveries(accountTargetTaskId);
      }
    },
  };
}
