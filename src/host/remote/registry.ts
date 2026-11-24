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
import { HostConnection, type HostStreamEvent } from "./connection.ts";
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
    task_id: string;
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
  private readonly remoteParents = new Set<string>();
  private readonly remoteLinks = new Map<
    string,
    { parentTaskId: string; host: string }
  >();
  private readonly refreshing = new Set<string>();
  private readonly bufferedEvents = new Map<string, HostStreamEvent[]>();
  private started = false;
  private readonly options?: HostRegistryOptions;

  constructor(
    configs: Record<string, HostConfig>,
    options?: HostRegistryOptions,
  ) {
    this.options = options;
    if (Object.keys(configs).length > 0) {
      for (const link of options?.listLinks() ?? []) this.rememberLink(link);
    }
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
        this.remoteParents.add(input.parentId);
        this.remoteLinks.set(nameKey(input.parentId, attempt.result.taskId), {
          parentTaskId: input.parentId,
          host,
        });
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
          const key = nameKey(host, attempt.result.taskId);
          this.mirror(key, {
            ...(this.mirrors.get(key) ?? {}),
            ...snapshot.item,
            workflowStatus:
              snapshot.item.workflowStatus ??
              this.mirrors.get(key)?.workflowStatus,
          });
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

  hasRemoteChild(localParentTaskId: string): boolean {
    return this.remoteParents.has(localParentTaskId);
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
    const link = this.remoteLinks.get(nameKey(localParentTaskId, remoteTaskId));
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
    return envelope.events.filter(
      (event): event is RemoteTaskSnapshot["events"][number] =>
        isRemoteEventRow(event) && event.task_id === target.taskId,
    );
  }

  // eslint-disable-next-line complexity -- one refresh owns display/catch-up ordering and stale-attempt fences.
  private async refresh(
    name: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection || !isCurrent()) return;
    this.refreshing.add(name);
    this.bufferedEvents.set(name, []);
    try {
      const links = (this.options?.listLinks() ?? []).filter(
        (link) => link.remote_role === "child" && link.remote_host === name,
      );
      if (links.length === 0) return;
      for (const link of links) this.rememberLink(link);
      const listsPromise = Promise.all(
        ["/api/v1/tasks", "/api/v1/tasks?archived=true"].map((path) =>
          connection
            .getJson(path)
            .then((value): unknown[] =>
              Array.isArray(value) ? (value as unknown[]) : [],
            )
            .catch((error: unknown) => {
              hlog.warn("remote list snapshot failed", {
                host: name,
                path,
                error: String(error),
              });
              return [];
            }),
        ),
      );
      for (const link of links) {
        if (!isCurrent()) return;
        await this.refreshChild(
          connection,
          name,
          link.remote_task_id,
          isCurrent,
        );
      }
      if (!isCurrent()) return;
      const lists = await listsPromise;
      if (!isCurrent()) return;
      const rows = new Map(
        lists
          .flat()
          .filter(isRemoteTaskListRow)
          .map((row) => [row.id, row] as const),
      );
      for (const link of links) {
        const row = rows.get(link.remote_task_id);
        const key = nameKey(name, link.remote_task_id);
        const current = this.mirrors.get(key);
        if (!row || !current) continue;
        this.mirror(key, {
          kind: "remote",
          id: link.remote_task_id,
          relation: "child",
          host: name,
          title: row.title ?? link.remote_task_id,
          workflowStatus: isWorkflowStatus(row.workflow_status)
            ? row.workflow_status
            : undefined,
          ...(current.executionState === undefined
            ? {}
            : { executionState: current.executionState }),
          ...(current.lastEventAt === undefined
            ? {}
            : { lastEventAt: current.lastEventAt }),
          ...(current.lastAgentActivityAt === undefined
            ? {}
            : { lastAgentActivityAt: current.lastAgentActivityAt }),
          ...(current.unreachable === undefined
            ? {}
            : { unreachable: current.unreachable }),
        });
      }
    } finally {
      this.refreshing.delete(name);
      const buffered = this.bufferedEvents.get(name) ?? [];
      this.bufferedEvents.delete(name);
      if (isCurrent()) {
        for (const event of buffered) this.applyEvent(name, event);
      }
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
    const eventsPromise = this.readEvents({
      host,
      taskId: childId,
      parentTaskId: "",
      connection,
    });
    const events = await eventsPromise.catch(() => null);
    if (!isCurrent()) return;
    const previous = this.mirrors.get(nameKey(host, childId));
    if (events || previous) {
      this.mirror(nameKey(host, childId), {
        kind: "remote",
        id: childId,
        relation: "child",
        host,
        ...(previous ?? {}),
        ...(events
          ? {
              lastEventAt: latestEventAt(events),
              lastAgentActivityAt: latestAgentActivityAt(events),
            }
          : {}),
      });
    }
    if (events) {
      for (const event of events) {
        if (!isCurrent()) return;
        const projected = remoteCatchupEvent(event, childId);
        if (projected) this.options?.onRemoteEvent(host, childId, projected);
      }
    }
    const status = await statusPromise;
    if (!isCurrent() || !status) return;
    const current = this.mirrors.get(nameKey(host, childId));
    if (current) {
      this.mirror(nameKey(host, childId), {
        ...current,
        executionState: executionStateFromStatus(status),
      });
    }
  }

  private async readSnapshot(
    connection: HostConnection,
    host: string,
    childId: string,
  ): Promise<RemoteTaskSnapshot> {
    const target: RemoteTaskTarget = {
      host,
      taskId: childId,
      parentTaskId: "",
      connection,
    };
    const [detailRaw, statusRaw, events] = await Promise.all([
      connection.getJson(`/api/v1/tasks/${encodeURIComponent(childId)}`),
      connection.getJson(`/api/v1/tasks/${encodeURIComponent(childId)}/status`),
      this.readEvents(target),
    ]);
    const detail = detailRaw as {
      id?: unknown;
      title?: unknown;
      workflowStatus?: unknown;
    };
    const status = statusRaw as { busy?: unknown; busyKind?: unknown };
    const item: RemoteTaskListItem = {
      kind: "remote",
      id: childId,
      relation: "child",
      host,
      title: typeof detail.title === "string" ? detail.title : undefined,
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
    if (this.refreshing.has(name)) {
      this.bufferedEvents.get(name)?.push(event);
      return;
    }
    this.applyEvent(name, event);
  }

  private applyEvent(name: string, event: HostStreamEvent): void {
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
    if (executionState) next.executionState = executionState;
    delete next.unreachable;
    this.mirror(key, next);
    this.options?.onRemoteEvent(name, childId, event);
  }

  private mirror(key: string, item: RemoteTaskListItem): void {
    this.mirrors.set(key, item);
  }

  private rememberLink(link: RemoteTaskLink): void {
    if (link.remote_role !== "child" || link.remote_host === null) return;
    this.remoteParents.add(link.local_task_id);
    this.remoteLinks.set(nameKey(link.local_task_id, link.remote_task_id), {
      parentTaskId: link.local_task_id,
      host: link.remote_host,
    });
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
    typeof row.task_id === "string" &&
    Number.isInteger(row.seq) &&
    typeof row.type === "string" &&
    typeof row.created_at === "string" &&
    typeof row.from_ref === "string" &&
    typeof row.data === "string"
  );
}

export function remoteCatchupEvent(
  value: unknown,
  expectedTaskId: string,
): { seq: number; data: Record<string, unknown> } | null {
  if (!isRemoteEventRow(value) || value.task_id !== expectedTaskId) return null;
  const data = parseObject(value.data);
  return data
    ? {
        seq: value.seq,
        data: { ...data, taskId: expectedTaskId, type: value.type },
      }
    : null;
}

interface RemoteTaskListRow {
  id: string;
  title: string | null;
  workflow_status: unknown;
}

function isRemoteTaskListRow(value: unknown): value is RemoteTaskListRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    (row.title === null || typeof row.title === "string")
  );
}

interface RemoteStatusRow {
  busy?: unknown;
  busyKind?: unknown;
}

function executionStateFromStatus(
  status: RemoteStatusRow,
): RemoteTaskListItem["executionState"] {
  if (status.busy !== true) return "idle";
  return status.busyKind === "bash" ? "bash" : "agent";
}

function executionStateFromPatch(
  patch: unknown,
): RemoteTaskListItem["executionState"] | undefined {
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

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
