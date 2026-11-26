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
} from "../../api/tasks.ts";
import { buildTaskHistoryQuery } from "../../task-history.ts";
import {
  TaskHostNotConfiguredError,
  TaskRemoteCancelRejectedError,
  TaskRemoteCancelUnknownError,
  TaskRemoteCreateNotSentError,
  TaskRemoteCreateRejectedError,
  TaskRemoteCreateUnknownError,
} from "../../api/tasks.ts";
import { log } from "../../log.ts";
import {
  HostConnection,
  REMOTE_STATUS_TIMEOUT_MS,
  type HostTaskCancelRequest,
} from "./connection.ts";
import type {
  HostRuntimeState,
  HostConnectionState,
  HostUnreachableReason,
} from "./state.ts";

const hlog = log.scope("hosts");

export interface RemoteTask {
  localTaskId: string;
  remoteTaskId: string;
  host: string;
}

export interface HostLinkWorker {
  start(): void;
  stop(): void;
  wakeOutbox(): void;
}

export interface HostRegistryOptions {
  fetch?: typeof globalThis.fetch;
  statusTimeoutMs?: number;
  listLinks: () => RemoteTask[];
  createLinkWorker?: (input: {
    host: string;
    connection: HostConnection;
    onState: (
      state: HostConnectionState,
      reason?: HostUnreachableReason,
    ) => void;
  }) => HostLinkWorker;
}

export class HostRegistry implements RemoteTaskCreateTransport {
  private readonly states = new Map<string, HostRuntimeState>();
  private readonly connections = new Map<string, HostConnection>();
  private readonly workers = new Map<string, HostLinkWorker>();
  private readonly statusTimeoutMs: number;
  private started = false;
  private readonly options?: HostRegistryOptions;

  constructor(
    configs: Record<string, HostConfig>,
    options?: HostRegistryOptions,
  ) {
    this.options = options;
    this.statusTimeoutMs = options?.statusTimeoutMs ?? REMOTE_STATUS_TIMEOUT_MS;
    for (const [name, config] of Object.entries(configs)) {
      this.states.set(name, {
        name,
        url: config.url,
        state: "connecting",
        reason: null,
        since: Date.now(),
      });
      const connection = new HostConnection(config, {
        fetch: options?.fetch,
      });
      this.connections.set(name, connection);
      if (options?.createLinkWorker) {
        this.workers.set(
          name,
          options.createLinkWorker({
            host: name,
            connection,
            onState: (state, reason) => {
              this.transition(name, state, reason);
            },
          }),
        );
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const worker of this.workers.values()) worker.start();
  }

  stopAll(): void {
    for (const worker of this.workers.values()) worker.stop();
  }

  wakeOutbox(host: string): void {
    this.workers.get(host)?.wakeOutbox();
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
      case "success":
        return attempt.result;
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

  async listRemoteChildren(localParentTaskId: string): Promise<TaskListItem[]> {
    const links = this.linksForParent(localParentTaskId);
    return Promise.all(links.map((link) => this.readChildStatusItem(link)));
  }

  /** Remote children of the given local parents, for list egress. */
  async listRemoteChildrenOf(
    parentTaskIds: ReadonlySet<string>,
  ): Promise<Array<TaskListItem & { parentTaskId: string }>> {
    if (this.connections.size === 0) return [];
    const links = (this.options?.listLinks() ?? []).filter((link) =>
      parentTaskIds.has(link.localTaskId),
    );
    return Promise.all(
      links.map(async (link) => ({
        ...(await this.readChildStatusItem(link)),
        parentTaskId: link.localTaskId,
      })),
    );
  }

  hasConnections(): boolean {
    return this.connections.size > 0;
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

  resolveRemoteChildByTaskId(
    remoteTaskId: string,
    isLiveParent: (localTaskId: string) => boolean,
  ): RemoteTaskTarget | undefined {
    if (this.connections.size === 0) return undefined;
    const link = (this.options?.listLinks() ?? []).find(
      (candidate) =>
        candidate.remoteTaskId === remoteTaskId &&
        isLiveParent(candidate.localTaskId),
    );
    if (!link) return undefined;
    const connection = this.connections.get(link.host);
    if (!connection) return undefined;
    return {
      host: link.host,
      taskId: link.remoteTaskId,
      parentTaskId: link.localTaskId,
      connection,
    };
  }

  async cancelRemote(
    target: RemoteTaskTarget,
    input: HostTaskCancelRequest,
  ): Promise<"idle" | "cancelling" | "cancelled" | "superseded"> {
    const attempt = await target.connection.cancelTask(target.taskId, input);
    switch (attempt.kind) {
      case "success":
        return attempt.status;
      case "rejected":
        throw new TaskRemoteCancelRejectedError(
          target.host,
          attempt.status,
          attempt.reason,
        );
      case "unknown":
        throw new TaskRemoteCancelUnknownError(target.host, attempt.reason);
    }
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

  private async readChildStatusItem(link: RemoteTask): Promise<TaskListItem> {
    const connection = this.connections.get(link.host);
    const watchConnected = this.states.get(link.host)?.state === "connected";
    if (!connection) {
      return {
        id: link.remoteTaskId,
        relation: "child",
        host: link.host,
        unreachable: true,
      };
    }
    try {
      const status = await connection.readTaskStatus(
        link.remoteTaskId,
        this.statusTimeoutMs,
      );
      return {
        id: link.remoteTaskId,
        relation: "child",
        host: link.host,
        title: status.title,
        workflowStatus: status.workflowStatus,
        executionState: status.executionState,
        lastEventAt: status.lastEventAt,
        lastAgentActivityAt: status.lastAgentActivityAt,
        ...(watchConnected ? {} : { unreachable: true as const }),
      };
    } catch {
      return {
        id: link.remoteTaskId,
        relation: "child",
        host: link.host,
        unreachable: true,
      };
    }
  }

  private linksForParent(localTaskId: string): RemoteTask[] {
    return (this.options?.listLinks() ?? []).filter(
      (link) => link.localTaskId === localTaskId,
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

export interface RemoteTaskTarget {
  host: string;
  taskId: string;
  parentTaskId: string;
  connection: HostConnection;
}
