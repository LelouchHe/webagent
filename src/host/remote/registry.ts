import type { HostConfig } from "../../config.ts";
import type {
  RemoteTaskCreateInput,
  RemoteTaskCreateTransport,
  RemoteTaskListItem,
  TaskCreateResult,
  TaskQueryInput,
  TaskQueryResult,
  TaskReadInput,
  TaskReadResult,
  TaskWorkflowStatus,
} from "../../api/tasks.ts";
import {
  parseTaskHistoryData,
  projectTaskHistoryRow,
  TASK_HISTORY_LIMITS,
} from "../../task-history.ts";
import { randomUUID } from "node:crypto";
import {
  TaskHostNotConfiguredError,
  TaskRemoteCreateNotSentError,
  TaskRemoteCreateRejectedError,
  TaskRemoteCreateUnknownError,
} from "../../api/tasks.ts";
import { log } from "../../log.ts";
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

export interface RemoteTaskLink {
  local_task_id: string;
  remote_task_id: string;
  remote_role: "parent" | "child";
  remote_host: string | null;
}

export interface RemoteTaskSnapshot {
  item: RemoteTaskListItem;
  events: Array<{
    seq: number;
    type: string;
    created_at: string;
    from_ref: string;
    data: string;
  }>;
}

export interface HostRegistryOptions {
  listLinks: () => RemoteTaskLink[];
  onRemoteEvent: (
    host: string,
    childId: string,
    event:
      | HostStreamEvent
      | {
          seq: number;
          data: Record<string, unknown>;
        },
  ) => void;
}

export class HostRegistry implements RemoteTaskCreateTransport {
  private readonly states = new Map<string, HostRuntimeState>();
  private readonly connections = new Map<string, HostConnection>();
  private readonly mirrors = new Map<string, RemoteTaskListItem>();
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
          retryDelay: (attempt) => retryDelay(attempt),
          onState: (state, reason) => {
            this.transition(name, state, reason);
          },
          onConnected: () => {
            return this.refresh(name);
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
        const activation = attempt.result.activation;
        if (activation) {
          this.mirror(nameKey(host, attempt.result.taskId), {
            kind: "remote",
            id: attempt.result.taskId,
            relation: "child",
            host,
            title: activation.title ?? attempt.result.taskId,
            workflowStatus: activation.workflowStatus,
          });
        }
        try {
          const snapshot = await this.readSnapshot(
            connection,
            host,
            attempt.result.taskId,
          );
          this.mirror(nameKey(host, attempt.result.taskId), snapshot.item);
        } catch (error) {
          hlog.warn("remote create snapshot failed", {
            host,
            taskId: attempt.result.taskId,
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

  listRemoteChildren(localParentTaskId: string): RemoteTaskListItem[] {
    const links = (this.options?.listLinks() ?? []).filter(
      (link) =>
        link.remote_role === "child" &&
        link.local_task_id === localParentTaskId &&
        link.remote_host !== null,
    );
    const stateByHost = this.states;
    return links.map((link) => {
      const host = link.remote_host!;
      const key = nameKey(host, link.remote_task_id);
      const mirrored = this.mirrors.get(key);
      return {
        ...(mirrored ?? {
          kind: "remote" as const,
          id: link.remote_task_id,
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

  async refreshAll(): Promise<void> {
    await Promise.all(
      [...this.connections.keys()].map((name) => this.refresh(name)),
    );
  }

  resolveRemoteChild(
    localParentTaskId: string,
    remoteTaskId: string,
  ): RemoteTaskTarget | undefined {
    const link = (this.options?.listLinks() ?? []).find(
      (candidate) =>
        candidate.remote_role === "child" &&
        candidate.local_task_id === localParentTaskId &&
        candidate.remote_task_id === remoteTaskId &&
        candidate.remote_host !== null,
    );
    if (!link?.remote_host) return undefined;
    const connection = this.connections.get(link.remote_host);
    if (!connection) return undefined;
    return {
      host: link.remote_host,
      taskId: remoteTaskId,
      parentTaskId: localParentTaskId,
      connection,
    };
  }

  async queryRemote(
    target: RemoteTaskTarget,
    input: TaskQueryInput,
  ): Promise<TaskQueryResult> {
    const events = await this.readEvents(target);
    const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    const [start, end] = normalizeRange(input.range, maxSeq);
    const rows = events
      .filter((event) => event.seq >= start && event.seq <= end)
      .map((event) => projectTaskHistoryRow(event, input.text))
      .filter((row) => input.text === undefined || row.field !== undefined);
    const result = { task_id: target.taskId, max_seq: maxSeq, rows };
    const required = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (required > TASK_HISTORY_LIMITS.queryBytes) {
      throw new Error(
        JSON.stringify({
          error: "response_too_large",
          required_bytes: required,
          limit_bytes: TASK_HISTORY_LIMITS.queryBytes,
          max_seq: maxSeq,
          hint: { range: [-Math.min(50, maxSeq), -1] },
        }),
      );
    }
    return result;
  }

  async readRemote(
    target: RemoteTaskTarget,
    input: TaskReadInput,
  ): Promise<TaskReadResult> {
    const uniqueSeqs = [...new Set(input.seqs)].sort((a, b) => a - b);
    if (
      uniqueSeqs.length > TASK_HISTORY_LIMITS.readSeqs &&
      uniqueSeqs.length !== 1
    ) {
      throw new Error(
        `too_many_seqs: maximum is ${TASK_HISTORY_LIMITS.readSeqs}`,
      );
    }
    const events = await this.readEvents(target);
    const bySeq = new Map(events.map((event) => [event.seq, event]));
    const missing = uniqueSeqs.filter((seq) => !bySeq.has(seq));
    if (missing.length > 0) {
      throw new Error(JSON.stringify({ error: "unknown_seq", missing }));
    }
    const rows = uniqueSeqs.map((seq) => {
      const event = bySeq.get(seq)!;
      return {
        seq: event.seq,
        type: event.type,
        at: event.created_at,
        from: event.from_ref,
        data: parseTaskHistoryData(event.data),
      };
    });
    const result = { task_id: target.taskId, rows };
    const limit =
      uniqueSeqs.length === 1
        ? TASK_HISTORY_LIMITS.readSingleBytes
        : TASK_HISTORY_LIMITS.readBytes;
    const required = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (required > limit) {
      throw new Error(
        JSON.stringify({
          error: "response_too_large",
          required_bytes: required,
          limit_bytes: limit,
          seqs: uniqueSeqs,
        }),
      );
    }
    return result;
  }

  async sendRemote(target: RemoteTaskTarget, body: string): Promise<void> {
    const result = await target.connection.sendTaskMessage({
      sourceTaskId: target.parentTaskId,
      targetTaskId: target.taskId,
      body,
      clientOpId: randomUUID(),
    });
    if (result.kind !== "accepted") {
      throw new Error(`Remote task send failed: ${result.reason}`);
    }
  }

  remoteTitle(target: RemoteTaskTarget): string | undefined {
    return this.mirrors.get(nameKey(target.host, target.taskId))?.title;
  }

  private async readEvents(
    target: RemoteTaskTarget,
  ): Promise<RemoteTaskSnapshot["events"]> {
    const raw = await target.connection.getJson(
      `/api/v1/tasks/${encodeURIComponent(target.taskId)}/events`,
    );
    const envelope = raw as { events?: unknown };
    if (!Array.isArray(envelope.events)) {
      throw new Error("Remote returned incomplete task events");
    }
    return envelope.events.filter(isRemoteEventRow);
  }

  private async refresh(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    const links = (this.options?.listLinks() ?? []).filter(
      (link) => link.remote_role === "child" && link.remote_host === name,
    );
    await Promise.all(
      links.map(async (link) => {
        try {
          const snapshot = await this.readSnapshot(
            connection,
            name,
            link.remote_task_id,
          );
          this.mirror(nameKey(name, link.remote_task_id), snapshot.item);
          for (const event of snapshot.events) {
            let data: unknown;
            try {
              data = JSON.parse(event.data) as unknown;
            } catch {
              continue;
            }
            if (data && typeof data === "object" && !Array.isArray(data)) {
              this.options?.onRemoteEvent(name, link.remote_task_id, {
                seq: event.seq,
                data: {
                  type: event.type,
                  taskId: link.remote_task_id,
                  ...data,
                },
              });
            }
          }
        } catch (error) {
          const previous = this.mirrors.get(nameKey(name, link.remote_task_id));
          this.mirror(nameKey(name, link.remote_task_id), {
            ...(previous ?? {
              kind: "remote",
              id: link.remote_task_id,
              relation: "child",
              host: name,
            }),
            unreachable: true,
          });
          if (!(error instanceof HostRequestError)) {
            hlog.warn("remote snapshot failed", {
              host: name,
              taskId: link.remote_task_id,
              error: String(error),
            });
          }
        }
      }),
    );
  }

  private async readSnapshot(
    connection: HostConnection,
    host: string,
    childId: string,
  ): Promise<RemoteTaskSnapshot> {
    const [detailRaw, statusRaw, eventsRaw] = await Promise.all([
      connection.getJson(`/api/v1/tasks/${encodeURIComponent(childId)}`),
      connection.getJson(`/api/v1/tasks/${encodeURIComponent(childId)}/status`),
      connection.getJson(`/api/v1/tasks/${encodeURIComponent(childId)}/events`),
    ]);
    const detail = detailRaw as {
      id?: unknown;
      title?: unknown;
      workflowStatus?: unknown;
    };
    const status = statusRaw as { busy?: unknown; busyKind?: unknown };
    const envelope = eventsRaw as {
      events?: unknown;
    };
    const events = Array.isArray(envelope.events)
      ? envelope.events.filter(isRemoteEventRow)
      : [];
    const item: RemoteTaskListItem = {
      kind: "remote",
      id: childId,
      relation: "child",
      host,
      title: typeof detail.title === "string" ? detail.title : undefined,
      workflowStatus: isWorkflowStatus(detail.workflowStatus)
        ? detail.workflowStatus
        : undefined,
      executionState:
        status.busy === true && status.busyKind === "bash"
          ? "bash"
          : status.busy === true
            ? "agent"
            : "idle",
      lastEventAt: latestEventAt(events),
      lastAgentActivityAt: latestAgentActivityAt(events),
    };
    return { item, events };
  }

  private acceptEvent(name: string, event: HostStreamEvent): void {
    const childId =
      typeof event.data.taskId === "string" ? event.data.taskId : null;
    if (!childId) return;
    const key = nameKey(name, childId);
    const current = this.mirrors.get(key);
    if (!current) return;
    const next: RemoteTaskListItem = {
      ...current,
      lastEventAt: new Date().toISOString(),
    };
    if (typeof event.data.title === "string") next.title = event.data.title;
    if (
      event.data.type === "task_update" &&
      isWorkflowStatus(event.data.status)
    ) {
      next.workflowStatus = event.data.status;
    }
    if (isAgentActivityEvent(event.data.type)) {
      next.lastAgentActivityAt = new Date().toISOString();
    }
    delete next.unreachable;
    this.mirror(key, next);
    this.options?.onRemoteEvent(name, childId, event);
  }

  private mirror(key: string, item: RemoteTaskListItem): void {
    this.mirrors.set(key, item);
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

function isWorkflowStatus(value: unknown): value is TaskWorkflowStatus {
  return ["running", "idle", "waiting", "blocked", "done"].includes(
    value as string,
  );
}

function isRemoteEventRow(
  value: unknown,
): value is RemoteTaskSnapshot["events"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isInteger(row.seq) &&
    typeof row.type === "string" &&
    typeof row.created_at === "string" &&
    typeof row.from_ref === "string" &&
    typeof row.data === "string"
  );
}

function isAgentActivityEvent(type: unknown): boolean {
  return [
    "assistant_message",
    "thinking",
    "tool_call",
    "tool_call_update",
    "permission_request",
    "plan",
  ].includes(type as string);
}

function latestEventAt(events: RemoteTaskSnapshot["events"]): string | null {
  return events.at(-1)?.created_at ?? null;
}

function latestAgentActivityAt(
  events: RemoteTaskSnapshot["events"],
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
