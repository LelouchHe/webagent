import { randomUUID } from "node:crypto";
import type { AgentBridge } from "../bridge.ts";
import type { Store } from "../store.ts";
import {
  isLocalCollaborationTarget,
  collaborationRelation,
} from "../task-collaboration.ts";
import type { TaskManager } from "../task-manager.ts";
import type {
  McpTaskHistoryRecord,
  McpTaskQueryResult,
  McpTaskListItem,
  McpTaskToolHost,
} from "./tools.ts";
import { compactTaskHistoryRecord } from "./task-history.ts";

const DEFAULT_QUERY_LIMIT = 5;
const MAX_QUERY_LIMIT = 100;

export interface McpTaskCollaborationEvent {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  body: string;
}

type QueryCursor = {
  taskId: string;
  beforeSeq: number;
  text?: string;
};

function encodeCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): QueryCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<QueryCursor>;
    const beforeSeq = parsed.beforeSeq;
    if (
      typeof parsed.taskId !== "string" ||
      typeof beforeSeq !== "number" ||
      !Number.isInteger(beforeSeq) ||
      beforeSeq < 1 ||
      (parsed.text !== undefined && typeof parsed.text !== "string")
    ) {
      throw new Error("invalid cursor");
    }
    return { taskId: parsed.taskId, beforeSeq, text: parsed.text };
  } catch {
    throw new Error("invalid_cursor");
  }
}

function relationOrder(relation: McpTaskListItem["relation"]): number {
  return { self: 0, parent: 1, child: 2, sibling: 3 }[relation];
}

export function createMcpTaskToolHost(deps: {
  store: Store;
  tasks: TaskManager;
  getBridge: () => AgentBridge | null;
  broadcastCollaboration?: (event: McpTaskCollaborationEvent) => void;
}): McpTaskToolHost {
  const { store, tasks, getBridge, broadcastCollaboration } = deps;

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

  return {
    list(sourceTaskId) {
      const source = requireTask(sourceTaskId);
      return store
        .listTasks()
        .map((task) => {
          const relation = collaborationRelation(source, task);
          if (!relation) return null;
          return {
            id: task.id,
            title: task.title ?? task.id,
            brief: task.brief || null,
            relation,
          } satisfies McpTaskListItem;
        })
        .filter((task): task is McpTaskListItem => task !== null)
        .sort(
          (a, b) =>
            relationOrder(a.relation) - relationOrder(b.relation) ||
            a.id.localeCompare(b.id),
        );
    },

    query(sourceTaskId, input): McpTaskQueryResult {
      const targetTaskId = input.taskId ?? sourceTaskId;
      const { target } =
        targetTaskId === sourceTaskId
          ? { target: requireTask(sourceTaskId) }
          : requireLocalTarget(sourceTaskId, targetTaskId);
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
      if (cursor && cursor.taskId !== target.id) {
        throw new Error("invalid_cursor");
      }
      if (cursor && input.text !== undefined && cursor.text !== input.text) {
        throw new Error("invalid_cursor");
      }

      const text = input.text ?? cursor?.text;
      const limit = Math.min(
        Math.max(1, input.limit ?? DEFAULT_QUERY_LIMIT),
        MAX_QUERY_LIMIT,
      );
      const beforeSeq = cursor?.beforeSeq;
      const events = store.getEvents(target.id, {
        excludeThinking: true,
        beforeSeq,
        limit,
        text,
      });
      if (events.length === 0) {
        return {
          workflowStatus: target.workflow_status,
          records: [],
          hasMore: false,
        };
      }
      const firstSeq = events[0].seq;
      const hasMore =
        store.getEvents(target.id, {
          excludeThinking: true,
          beforeSeq: firstSeq,
          limit: 1,
          text,
        }).length > 0;

      const records: McpTaskHistoryRecord[] = events
        .map((event) =>
          compactTaskHistoryRecord({
            seq: event.seq,
            type: event.type,
            data: event.data,
            createdAt: event.created_at,
          }),
        )
        .filter((record): record is McpTaskHistoryRecord => record !== null);
      return {
        workflowStatus: target.workflow_status,
        records,
        hasMore,
        ...(hasMore
          ? {
              nextCursor: encodeCursor({
                taskId: target.id,
                beforeSeq: firstSeq,
                text,
              }),
            }
          : {}),
      };
    },

    async send(sourceTaskId, targetTaskId, body) {
      const bridge = getBridge();
      const { target } = requireLocalTarget(sourceTaskId, targetTaskId);
      const created = store.createCollaborationMessage({
        id: randomUUID(),
        deliveryId: randomUUID(),
        sourceTaskId,
        directTargetTaskId: target.id,
        sourceActor: "agent",
        body,
      });
      broadcastCollaboration?.({
        messageId: created.message.id,
        sourceTaskId,
        targetTaskId: target.id,
        body: created.message.body,
      });
      if (bridge) {
        void tasks.drainCollaborationDeliveries(bridge, target.id);
      }
    },

    async update(sourceTaskId, status, body) {
      const bridge = getBridge();
      const { parentTaskId, collaborationMessageId } =
        store.recordAgentWorkflowUpdate(sourceTaskId, status, body);
      if (collaborationMessageId && parentTaskId) {
        broadcastCollaboration?.({
          messageId: collaborationMessageId,
          sourceTaskId,
          targetTaskId: parentTaskId,
          body: `Task status: ${status}\n${body}`,
        });
      }
      if (bridge && parentTaskId) {
        void tasks.drainCollaborationDeliveries(bridge, parentTaskId);
      }
    },
  };
}
