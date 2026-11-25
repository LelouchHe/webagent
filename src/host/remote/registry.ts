import type { HostConfig } from "../../config.ts";
import type {
  RemoteTaskCreateInput,
  RemoteTaskCreateTransport,
  TaskListItem,
  TaskCreateResult,
  TaskQueryInput,
  TaskQueryResult,
  TaskReadInput,
  TaskReadResult,
  TaskSendResult,
} from "../../api/tasks.ts";
import {
  buildTaskHistoryQuery,
  type CanonicalTaskHistoryEvent,
} from "../../task-history.ts";
import { randomUUID } from "node:crypto";
import {
  TaskHostNotConfiguredError,
  TaskRemoteCreateNotSentError,
  TaskRemoteCreateRejectedError,
  TaskRemoteCreateUnknownError,
} from "../../api/tasks.ts";
import { log } from "../../log.ts";
import { HTTP_STATUS } from "../../http-status.ts";
import { isWorkflowStatus } from "../../shared/workflow-status.ts";
import {
  HostConnection,
  HostRequestError,
  type HostStreamEvent,
} from "./connection.ts";
import {
  retryDelay,
  type HostRuntimeState,
  type HostConnectionState,
  type HostUnreachableReason,
} from "./state.ts";

const hlog = log.scope("hosts");

export interface RemoteTask {
  localTaskId: string;
  remoteTaskId: string;
  host: string;
}

export interface HostRegistryOptions {
  fetch?: typeof globalThis.fetch;
  listLinks: () => RemoteTask[];
  onRemoteEvent: (
    host: string,
    childId: string,
    event: HostStreamEvent,
  ) => void;
}

export class HostRegistry implements RemoteTaskCreateTransport {
  private readonly states = new Map<string, HostRuntimeState>();
  private readonly connections = new Map<string, HostConnection>();
  private readonly mirrors = new Map<string, TaskListItem>();
  private started = false;
  private readonly options?: HostRegistryOptions;

  constructor(
    configs: Record<string, HostConfig>,
    options?: HostRegistryOptions,
  ) {
    this.options = options;
    for (const [name, config] of Object.entries(configs)) {
      this.states.set(name, {
        name,
        url: config.url,
        state: "connecting",
        reason: null,
        since: Date.now(),
      });
      this.connections.set(
        name,
        new HostConnection(config, {
          fetch: options?.fetch,
          retryDelay: (attempt) => retryDelay(attempt),
          subscriptionParentIds: () =>
            (this.options?.listLinks() ?? [])
              .filter((link) => link.host === name)
              .map((link) => link.localTaskId),
          onState: (state, reason) => {
            this.transition(name, state, reason);
          },
          onConnected: (isCurrent) => {
            return this.refresh(name, isCurrent);
          },
          onEvent: (event) => {
            this.acceptEvent(name, event);
          },
        }),
      );
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const connection of this.connections.values()) connection.start();
  }

  stopAll(): void {
    for (const connection of this.connections.values()) connection.stop();
  }

  list(): HostRuntimeState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  async create(
    host: string,
    input: RemoteTaskCreateInput,
  ): Promise<TaskCreateResult> {
    const connection = this.connections.get(host);
    if (!connection) throw new TaskHostNotConfiguredError(host);
    const attempt = await connection.createTask(input);
    switch (attempt.kind) {
      case "success": {
        if (!attempt.subscribed) connection.reconnect();
        const { task } = attempt.result;
        this.mirror(nameKey(host, task.id), {
          id: task.id,
          relation: "child",
          host,
          title: task.title ?? task.id,
          workflowStatus: task.workflowStatus,
        });
        try {
          await this.refreshChild(connection, host, task.id, () => true);
        } catch (error) {
          hlog.warn("remote create snapshot failed", {
            host,
            taskId: task.id,
            error: String(error),
          });
        }
        return attempt.result;
      }
      case "rejected":
        throw new TaskRemoteCreateRejectedError(
          host,
          attempt.status,
          attempt.reason,
        );
      case "unknown":
        throw new TaskRemoteCreateUnknownError(host, attempt.reason);
      case "not_sent":
        throw new TaskRemoteCreateNotSentError(host, attempt.reason);
    }
  }

  listRemoteChildren(localParentTaskId: string): TaskListItem[] {
    const links = this.linksForParent(localParentTaskId);
    const stateByHost = this.states;
    return links.map((link) => {
      const host = link.host;
      const key = nameKey(host, link.remoteTaskId);
      const mirrored = this.mirrors.get(key);
      return {
        ...(mirrored ?? {
          id: link.remoteTaskId,
          relation: "child" as const,
          host,
        }),
        ...(stateByHost.get(host)?.state === "connected" &&
        mirrored?.unreachable === undefined
          ? {}
          : { unreachable: true as const }),
      };
    });
  }

  /** Remote children of the given local parents, for list egress. */
  listRemoteChildrenOf(
    parentTaskIds: ReadonlySet<string>,
  ): Array<TaskListItem & { parentTaskId: string }> {
    if (this.connections.size === 0) return [];
    const parents = new Set(
      (this.options?.listLinks() ?? [])
        .map((link) => link.localTaskId)
        .filter((id) => parentTaskIds.has(id)),
    );
    return [...parents].flatMap((parentTaskId) =>
      this.listRemoteChildren(parentTaskId).map((item) => ({
        ...item,
        parentTaskId,
      })),
    );
  }

  hasRemoteChild(localParentTaskId: string): boolean {
    if (this.connections.size === 0) return false;
    return this.linksForParent(localParentTaskId).length > 0;
  }

  resolveRemoteChild(
    localParentTaskId: string,
    remoteTaskId: string,
  ): RemoteTaskTarget | undefined {
    if (this.connections.size === 0) return undefined;
    const link = this.linksForParent(localParentTaskId).find(
      (candidate) => candidate.remoteTaskId === remoteTaskId,
    );
    if (!link) return undefined;
    const connection = this.connections.get(link.host);
    if (!connection) return undefined;
    return {
      host: link.host,
      taskId: remoteTaskId,
      parentTaskId: localParentTaskId,
      connection,
    };
  }

  async queryRemote(
    target: RemoteTaskTarget,
    input: TaskQueryInput,
  ): Promise<TaskQueryResult> {
    const events = await target.connection.readTaskEvents(target.taskId);
    const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    return buildTaskHistoryQuery({
      taskId: target.taskId,
      events,
      maxSeq,
      range: input.range,
      text: input.text,
    });
  }

  async readRemote(
    target: RemoteTaskTarget,
    input: TaskReadInput,
  ): Promise<TaskReadResult> {
    return target.connection.readTaskHistory(target.taskId, input);
  }

  async sendRemote(
    target: RemoteTaskTarget,
    body: string,
    sourceLabel: string,
  ): Promise<TaskSendResult> {
    const result = await target.connection.sendTaskMessage({
      sourceTaskId: target.parentTaskId,
      targetTaskId: target.taskId,
      body,
      sourceLabel,
      clientOpId: randomUUID(),
    });
    if (result.kind !== "accepted") {
      throw new Error(`Remote task send failed: ${result.reason}`);
    }
    return {
      messageId: result.messageId,
      targetTaskId: target.taskId,
      targetLabel: this.remoteTitle(target) ?? target.taskId.slice(0, 8),
      sourceLabel,
      targetIsLocal: false,
    };
  }

  remoteTitle(target: RemoteTaskTarget): string | undefined {
    return (
      this.mirrors.get(nameKey(target.host, target.taskId))?.title ?? undefined
    );
  }

  remoteTitleForTaskId(taskId: string): string | undefined {
    for (const mirror of this.mirrors.values()) {
      if (mirror.id === taskId) return mirror.title ?? undefined;
    }
    return undefined;
  }

  private async refresh(
    name: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection || !isCurrent()) return;
    try {
      const links = this.linksForHost(name);
      if (links.length === 0) return;
      for (const link of links) {
        if (!isCurrent()) return;
        await this.refreshChild(connection, name, link.remoteTaskId, isCurrent);
      }
    } catch (error) {
      if (isCurrent()) throw error;
    }
  }

  private async refreshChild(
    connection: HostConnection,
    host: string,
    childId: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    const statusPromise = connection
      .getJson(`/api/v1/tasks/${encodeURIComponent(childId)}/status`)
      .then((value) => value as RemoteStatusRow)
      .catch(() => null);
    const detailPromise = connection
      .readTaskDetail(childId)
      .catch((error: unknown) => {
        if (
          error instanceof HostRequestError &&
          error.status === HTTP_STATUS.NOT_FOUND
        ) {
          this.markUnreachable(host, childId);
        }
        return null;
      });
    const eventsPromise = connection.readTaskEvents(childId);
    let events: Awaited<ReturnType<HostConnection["readTaskEvents"]>>;
    try {
      events = await eventsPromise;
    } catch (error) {
      if (
        error instanceof HostRequestError &&
        error.status === HTTP_STATUS.NOT_FOUND
      ) {
        this.markUnreachable(host, childId);
        return;
      }
      throw error;
    }
    if (!isCurrent()) return;
    for (const event of events) {
      if (!isCurrent()) return;
      this.options?.onRemoteEvent(host, childId, remoteCatchupEvent(event));
    }
    const [detail, status] = await Promise.all([detailPromise, statusPromise]);
    if (!isCurrent() || !status) return;
    const previous = this.mirrors.get(nameKey(host, childId));
    this.mirror(nameKey(host, childId), {
      id: childId,
      relation: "child",
      host,
      ...(previous ?? {}),
      ...(detail
        ? {
            title: detail.title ?? childId,
            workflowStatus: detail.workflowStatus,
          }
        : {}),
      executionState: executionStateFromStatus(status),
      lastEventAt: latestEventAt(events),
      lastAgentActivityAt: latestAgentActivityAt(events),
    });
  }

  private acceptEvent(name: string, event: HostStreamEvent): void {
    this.applyEvent(name, event);
  }

  private applyEvent(name: string, event: HostStreamEvent): void {
    const childId =
      typeof event.data.taskId === "string" ? event.data.taskId : null;
    if (!childId) return;
    const key = nameKey(name, childId);
    const current = this.mirrors.get(key);
    if (!current) return;
    const next: TaskListItem = {
      ...current,
      lastEventAt: new Date().toISOString(),
    };
    if (
      event.data.type === "task_title_updated" &&
      typeof event.data.title === "string"
    ) {
      next.title = event.data.title;
    }
    if (
      event.data.type === "task_update" &&
      isWorkflowStatus(event.data.status)
    ) {
      next.workflowStatus = event.data.status;
    }
    if (isAgentActivityEvent(event.data.type)) {
      next.lastAgentActivityAt = new Date().toISOString();
    }
    const executionState = executionStateFromPatch(event.data.patch);
    if (executionState) {
      next.executionState = executionState;
      if (executionState === "agent") {
        next.workflowStatus = "running";
      } else if (
        executionState === "idle" &&
        next.workflowStatus === "running"
      ) {
        next.workflowStatus = "idle";
      }
    }
    delete next.unreachable;
    this.mirror(key, next);
    this.options?.onRemoteEvent(name, childId, event);
  }

  private mirror(key: string, item: TaskListItem): void {
    this.mirrors.set(key, item);
  }

  private markUnreachable(host: string, childId: string): void {
    const key = nameKey(host, childId);
    const previous = this.mirrors.get(key);
    this.mirror(key, {
      ...(previous ?? {
        id: childId,
        relation: "child",
        host,
      }),
      unreachable: true,
    });
  }

  private linksForParent(localTaskId: string): RemoteTask[] {
    return (this.options?.listLinks() ?? []).filter(
      (link) => link.localTaskId === localTaskId,
    );
  }

  private linksForHost(host: string): RemoteTask[] {
    return (this.options?.listLinks() ?? []).filter(
      (link) => link.host === host,
    );
  }

  private transition(
    name: string,
    state: HostConnectionState,
    reason?: HostUnreachableReason,
  ): void {
    const current = this.states.get(name);
    if (!current) return;
    const nextReason = state === "unreachable" ? (reason ?? "network") : null;
    if (current.state === state && current.reason === nextReason) return;
    this.states.set(name, {
      ...current,
      state,
      reason: nextReason,
      since: Date.now(),
    });
    hlog.info("state changed", {
      host: name,
      state,
      ...(nextReason ? { reason: nextReason } : {}),
    });
  }
}

function nameKey(host: string, taskId: string): string {
  return `${host}\0${taskId}`;
}

export function remoteCatchupEvent(
  event: import("./connection.ts").OwnerTaskHistoryEvent,
): HostStreamEvent {
  return {
    seq: event.seq,
    data: {
      ...event.parsedData,
      taskId: event.task_id,
      type: event.type,
    },
  };
}

interface RemoteStatusRow {
  busy?: unknown;
  busyKind?: unknown;
}

function executionStateFromStatus(
  status: RemoteStatusRow,
): TaskListItem["executionState"] {
  if (status.busy !== true) return "idle";
  return status.busyKind === "bash" ? "bash" : "agent";
}

function executionStateFromPatch(
  patch: unknown,
): TaskListItem["executionState"] | undefined {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return undefined;
  const runtime = (patch as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime))
    return undefined;
  const busy = (runtime as { busy?: unknown }).busy;
  if (busy === null) return "idle";
  if (!busy || typeof busy !== "object" || Array.isArray(busy))
    return undefined;
  const kind = (busy as { kind?: unknown }).kind;
  return kind === "bash" ? "bash" : kind === "agent" ? "agent" : undefined;
}

function isAgentActivityEvent(type: unknown): boolean {
  return [
    "assistant_message",
    "thinking",
    "message_chunk",
    "thought_chunk",
    "agent_image",
    "tool_call",
    "tool_call_update",
    "permission_request",
    "plan",
  ].includes(type as string);
}

function latestEventAt(
  events: readonly CanonicalTaskHistoryEvent[],
): string | null {
  return events.at(-1)?.created_at ?? null;
}

function latestAgentActivityAt(
  events: readonly CanonicalTaskHistoryEvent[],
): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    if (isAgentActivityEvent(events[index].type))
      return events[index].created_at;
  }
  return null;
}

export interface RemoteTaskTarget {
  host: string;
  taskId: string;
  parentTaskId: string;
  connection: HostConnection;
}
