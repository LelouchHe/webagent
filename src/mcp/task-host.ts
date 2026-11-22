import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Store, TaskRow } from "../store.ts";
import { collaborationRelation } from "../task-collaboration.ts";
import { TaskLocator } from "../task-locator.ts";
import { DeliveryQueue } from "../delivery-queue.ts";
import type { HostRegistry } from "../host-registry.ts";
import { hostRequestHash } from "../host-registry.ts";
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
import { isoFromMillisOrNull } from "../shared/time.ts";
import { buildTaskCreatedSystemMessage } from "../task-created-message.ts";
import { formatSilence } from "../obligation-controller.ts";
import type {
  McpCallerPrincipal,
  McpTaskQueryResult,
  McpTaskListItem,
  McpTaskToolHost,
  McpTaskReadResult,
  McpTaskCreateInput,
  McpTaskCreateResult,
} from "./tools.ts";
import { queryTaskHistory, readTaskHistory } from "./task-history.ts";
import {
  agentStartError,
  configOverrideError,
  unconfiguredAgentError,
} from "./create-errors.ts";

export interface McpTaskCollaborationEvent {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  /** Raw title of each side; the shared builder renders the title from them. */
  sourceLabel: string;
  targetLabel: string;
  body: string;
  /** The task this projection renders into. */
  taskId: string;
  role: "source" | "target";
  deliveryStatus?: "queued" | "delivered" | "failed";
  deliveredAt?: string;
  deliveryFailureReason?: string;
}

export interface McpTaskCreatedEvent {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  /** Raw title of the created task; the row's reference is rebuilt from it. */
  taskTitle: string;
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
  return { self: 0, parent: 1, child: 2 }[relation];
}

export function createMcpTaskToolHost(deps: {
  store: Store;
  tasks: TaskManager;
  cancelTimeoutMs?: number;
  broadcastCollaboration?: (event: McpTaskCollaborationEvent) => void;
  broadcastTaskCreated?: (event: McpTaskCreatedEvent) => void;
  broadcastTaskCancelNotice?: (event: McpTaskCancelNotice) => void;
  hosts?: HostRegistry;
}): McpTaskToolHost {
  const {
    store,
    tasks,
    broadcastCollaboration,
    broadcastTaskCreated,
    broadcastTaskCancelNotice,
  } = deps;
  const locator = new TaskLocator(store);
  const deliveries = new DeliveryQueue(store, locator, {
    drainLocal: (taskId) => {
      void tasks.drainCollaborationDeliveries(taskId);
    },
    kickEdge: (edgeId) => deps.hosts?.kick(edgeId),
    notifyExternal: (credentialHash) => {
      tasks.notifyExternalMessage(credentialHash);
    },
  });

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

  function requireHistoryTarget(sourceTaskId: string, targetTaskId: string) {
    const source = store.getTask(sourceTaskId);
    const target = store.getTask(targetTaskId);
    if (
      !source ||
      !target ||
      (source.id !== target.id &&
        collaborationRelation(source, target) === null)
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

  return {
    list(principal) {
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
      const listed = entries.map(({ task, relation }): McpTaskListItem => ({
        id: task.id,
        title: task.title ?? task.id,
        relation,
        workflowStatus: task.workflow_status,
        executionState: tasks.getExecutionState(task.id),
        lastAgentActivityAt: tasks.getLastAgentActivityAt(task.id),
        lastEventAt: isoFromMillisOrNull(lastEventTimes.get(task.id)),
      }));
      if (!store.hasHostFacts()) return listed;
      const localIds = new Set(listed.map((item) => item.id));
      const externalParent = locator.parentOf(source.id);
      if (
        externalParent &&
        externalParent !== source.parent_id &&
        !localIds.has(externalParent)
      ) {
        listed.push({
          id: externalParent,
          title: externalParent,
          relation: "parent",
          external: true,
        });
      }
      for (const edge of store.listHostEdgesForParent(source.id)) {
        if (localIds.has(edge.remote_task_id)) continue;
        listed.push({
          id: edge.remote_task_id,
          title: edge.display_title,
          relation: "child",
          external: true,
          hostLabel: edge.host_name,
        });
      }
      return listed.sort(
        (a, b) =>
          relationOrder(a.relation) - relationOrder(b.relation) ||
          a.id.localeCompare(b.id),
      );
    },

    query(principal, input): McpTaskQueryResult {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const targetId = input.taskId ?? sourceTaskId;
      const target = requireHistoryTarget(sourceTaskId, targetId);
      return queryTaskHistory(store, target.id, input);
    },

    read(principal, input): McpTaskReadResult {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const target = requireHistoryTarget(
        sourceTaskId,
        input.taskId ?? sourceTaskId,
      );
      return readTaskHistory(store, target.id, input);
    },

    // eslint-disable-next-line complexity -- local and remote create have separate fenced write paths
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
      const remote = requestedAgent
        ? (deps.hosts?.remoteAgentId(requestedAgent) ?? null)
        : null;
      if (requestedAgent && remote) {
        const source = requireTask(sourceTaskId);
        if (store.siblingTitleExists(source.id, input.title)) {
          throw new Error("task_title_conflict");
        }
        const createKey = randomUUID();
        const request = {
          createKey,
          parentTaskId: source.id,
          agent: remote.agentId,
          title: input.title,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
        };
        const result = await deps.hosts!.createTask({
          hostName: remote.hostName,
          credentialHash: remote.credentialHash,
          request,
        });
        authorize(principal);
        const created = store.createHostEdge({
          parentTaskId: source.id,
          hostName: remote.hostName,
          remoteTaskId: result.taskId,
          title: input.title,
          credentialHash: result.credentialHash,
          createKey,
          requestHash: hostRequestHash(request),
          event: {
            title: `Created remote task ${input.title} @${remote.hostName}`,
            body: `Host: ${remote.hostName}\nTask: ${result.taskId}`,
            kind: "task_created_remote",
            taskId: result.taskId,
            taskTitle: input.title,
            agentId: remote.agentId,
            cwd: input.cwd ?? "owner default",
            model: input.model ?? null,
            thinking: input.thinking ?? null,
          },
        });
        if (created.status === "conflict" || created.edge === null) {
          throw new Error("task_create_conflict");
        }
        return { taskId: result.taskId };
      }
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
        taskTitle: input.title,
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
      const sourceLabel = sourceTask?.title ?? sourceTaskId.slice(0, 8);
      const targetLabel = targetTask?.title ?? target.id.slice(0, 8);
      const sourceRef = formatTaskReference(sourceLabel);
      const targetRef = formatTaskReference(targetLabel);
      const body = formatFieldBlock([
        { label: "reason", value: reason },
        { label: "status", value: result.status },
      ]);
      const rows = [
        {
          taskId: sourceTaskId,
          role: "source" as const,
          title: `${sourceRef} cancelled ${targetRef}`,
        },
        {
          taskId: target.id,
          role: "target" as const,
          title: `Cancelled by ${sourceRef}`,
        },
      ];
      for (const row of rows) {
        const data = {
          kind: "task_cancel" as const,
          role: row.role,
          sourceTaskId,
          sourceLabel,
          targetTaskId: target.id,
          targetLabel,
          reason,
          status: result.status,
          title: row.title,
          body,
        };
        store.saveEvent(row.taskId, "system_message", data, {
          from_ref: "agent",
        });
        broadcastTaskCancelNotice?.({
          type: "system_message",
          taskId: row.taskId,
          kind: data.kind,
          role: data.role,
          sourceTaskId,
          sourceLabel,
          targetTaskId: target.id,
          targetLabel,
          title: data.title,
          body,
        });
      }
      return { accepted: true, taskId: target.id, status: result.status };
    },

    async send(principal, targetTaskId, body) {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      const route = locator.route(sourceTaskId, targetTaskId);
      if (route.relation !== "child" && route.relation !== "parent") {
        throw new Error(
          route.endpoint ? "target_not_allowed" : "task_not_found",
        );
      }
      const created = deliveries.enqueue(
        {
          sourceId: sourceTaskId,
          targetId: targetTaskId,
          kind: route.relation === "child" ? "dispatch" : "message",
          body,
        },
        route,
      );
      const source = requireTask(sourceTaskId);
      const target = created.endpoint;
      const targetLabel =
        target.kind === "local"
          ? (target.task.title ?? target.task.id.slice(0, 8))
          : target.kind === "remote_child"
            ? target.edge.display_title
            : targetTaskId.slice(0, 8);
      const sourceLabel = source.title ?? source.id.slice(0, 8);
      broadcastCollaboration?.({
        messageId: created.message.id,
        sourceTaskId,
        targetTaskId,
        sourceLabel,
        targetLabel,
        body: created.message.body,
        taskId: sourceTaskId,
        role: "source",
        deliveryStatus: "queued",
      });
    },

    async update(principal, status, body) {
      authorize(principal);
      const sourceTaskId = principal.taskId;
      // `waiting` only records the status. `done` and `blocked` settle the
      // target's open account and are delivered to its source, or fall back to
      // the current parent when no account is open.
      const { collaborationMessageId, accountTargetTaskId, silenceWatchMs } =
        tasks.settleAgentUpdate(sourceTaskId, status, body);
      if (collaborationMessageId && accountTargetTaskId) {
        const source = requireTask(sourceTaskId);
        const target = locator.endpoint(accountTargetTaskId, sourceTaskId);
        if (!target) return {};
        broadcastCollaboration?.({
          messageId: collaborationMessageId,
          sourceTaskId,
          targetTaskId: accountTargetTaskId,
          sourceLabel: source.title ?? source.id.slice(0, 8),
          targetLabel:
            target.kind === "local"
              ? (target.task.title ?? target.task.id.slice(0, 8))
              : accountTargetTaskId.slice(0, 8),
          body: `Task status: ${status}\n${body}`,
          taskId: sourceTaskId,
          role: "source",
          deliveryStatus: "queued",
        });
        if (target.kind === "local") {
          void tasks.drainCollaborationDeliveries(accountTargetTaskId);
        }
      }
      if (silenceWatchMs === undefined) return {};
      return {
        note: `No visible wake source; the requester is notified after ${formatSilence(silenceWatchMs)} without agent activity.`,
      };
    },
  };
}
