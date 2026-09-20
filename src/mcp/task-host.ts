import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { AgentBridge } from "../bridge.ts";
import type { Store, TaskRow } from "../store.ts";
import {
  isLocalCollaborationTarget,
  collaborationRelation,
} from "../task-collaboration.ts";
import type { TaskManager } from "../task-manager.ts";
import { expandHomePath } from "../home-path.ts";
import { formatTaskReference } from "../shared/task-reference.ts";
import { isoFromMillis, isoFromMillisOrNull } from "../shared/time.ts";
import { buildTaskCreatedSystemMessage } from "../task-created-message.ts";
import type {
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

function relationOrder(relation: McpTaskListItem["relation"]): number {
  return { self: 0, parent: 1, child: 2, sibling: 3 }[relation];
}

export function createMcpTaskToolHost(deps: {
  store: Store;
  tasks: TaskManager;
  getBridge: () => AgentBridge | null;
  cancelTimeoutMs?: number;
  broadcastCollaboration?: (event: McpTaskCollaborationEvent) => void;
  broadcastTaskCreated?: (event: McpTaskCreatedEvent) => void;
}): McpTaskToolHost {
  const {
    store,
    tasks,
    getBridge,
    broadcastCollaboration,
    broadcastTaskCreated,
  } = deps;

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
    list(sourceTaskId) {
      const source = requireTask(sourceTaskId);
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

    query(sourceTaskId, input): McpTaskQueryResult {
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

    read(sourceTaskId, input): McpTaskReadResult {
      const target = requireHistoryTarget(sourceTaskId, input.taskId);
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
      sourceTaskId: string,
      input: McpTaskCreateInput,
    ): Promise<McpTaskCreateResult> {
      const bridge = getBridge();
      if (!bridge) throw new Error("agent_not_ready");
      const source = requireTask(sourceTaskId);
      const requestedCwd = input.cwd ? expandHomePath(input.cwd) : source.cwd;
      const cwd = isAbsolute(requestedCwd)
        ? requestedCwd
        : resolve(source.cwd, requestedCwd);
      const created = await tasks.createTask(bridge, cwd, source.id, "agent", {
        parentId: source.id,
        title: input.title,
        model: input.model,
        thinking: input.thinking,
      });
      const taskCreatedMessageId = randomUUID();
      const taskCreated = buildTaskCreatedSystemMessage({
        taskId: created.taskId,
        taskTitle: input.title,
        cwd,
        model: input.model,
        thinking: input.thinking,
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

    async cancel(sourceTaskId, targetTaskId, reason) {
      const bridge = getBridge();
      const { target } = requireChildTarget(sourceTaskId, targetTaskId);
      const result = await tasks.cancelTaskExecution(
        target.id,
        bridge,
        deps.cancelTimeoutMs ?? 0,
      );
      store.saveEvent(
        target.id,
        "task_cancel",
        { sourceTaskId, reason, status: result.status },
        { from_ref: "agent" },
      );
      return { accepted: true, taskId: target.id, status: result.status };
    },

    async send(sourceTaskId, targetTaskId, body) {
      const bridge = getBridge();
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
      if (bridge) {
        void tasks.drainCollaborationDeliveries(bridge, target.id);
      }
    },

    async update(sourceTaskId, status, body) {
      const bridge = getBridge();
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
        if (bridge) {
          void tasks.drainCollaborationDeliveries(bridge, accountTargetTaskId);
        }
      }
    },
  };
}
