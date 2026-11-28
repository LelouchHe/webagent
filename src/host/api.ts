import type {
  TaskCaller,
  TaskCancelOutcome,
  TaskCreateCaller,
  TaskCreateInput,
  TaskCreateResult,
  TaskListItem,
  TaskQueryInput,
  TaskQueryResult,
  TaskReadInput,
  TaskReadResult,
  TaskSendResult,
} from "../api/tasks.ts";

export type RemoteTaskDeleteAttempt =
  | { kind: "deleted" }
  | { kind: "skipped" }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "unknown"; reason: string };

export type RemoteTaskDeleter = (
  host: string,
  taskId: string,
  beforeSend?: () => boolean | void,
) => Promise<RemoteTaskDeleteAttempt>;

export interface RemoteTaskCreateInput {
  opId: string | null;
  agentId: string;
  parentId: string;
  title?: string;
  cwd?: string;
  source: string;
}

export interface RemoteTaskCreateTransport {
  create(host: string, input: RemoteTaskCreateInput): Promise<TaskCreateResult>;
}

export interface TaskCreateTarget {
  agentId?: string;
  host?: string;
}

export interface TaskCreateHostCommand {
  caller: TaskCreateCaller;
  input: TaskCreateInput;
  target: TaskCreateTarget;
  parentId?: string;
  assertCaller: () => void;
  assertRemoteCaller: () => void;
}

export type TaskCreateHostOutcome =
  | {
      kind: "local";
      replayed: boolean;
      result: TaskCreateResult;
    }
  | {
      kind: "remote";
      host: string;
      result: TaskCreateResult;
    };

export type TaskCancelHostCommand =
  | {
      kind: "user";
      taskId: string;
    }
  | {
      kind: "host";
      taskId: string;
    }
  | {
      kind: "agent";
      sourceTaskId: string;
      targetTaskId: string;
      reason: string;
      prepareLocal: () => void;
      prepareRemote: () => { sourceLabel: string };
      beforeSend: () => void;
    };

export interface TaskCancelHostOutcome {
  kind: "local" | "remote";
  taskId: string;
  status: TaskCancelOutcome["status"];
}

export interface TaskSendHostCommand {
  principal: TaskCaller;
  targetTaskId: string;
  body: string;
  /** Synchronous audit + authorization callback invoked inside local's transaction. */
  recordLocalSend: (performed: TaskSendResult) => void;
}

export interface TaskSendHostOutcome {
  kind: "local" | "remote";
  result: TaskSendResult;
}

export interface TaskReportDelivery {
  sourceTaskId: string;
  targetTaskId: string;
  targetIsLocal: boolean;
  sourceLabel: string;
  targetLabel: string;
  body: string;
}

export interface TaskReportDeliveryResult {
  drainLocalTargetTaskId?: string;
}

/**
 * Unified Host port consumed by Core (`src/task-ops.ts`).
 *
 * Core never chooses between local and remote execution: it passes structured
 * commands and synchronous audit/authorization callbacks to `TaskHost`, and
 * `src/host/` internally routes between `src/host/local/` and `src/host/remote/`.
 */
export interface TaskHost {
  list(principal: TaskCaller): Promise<TaskListItem[]>;
  query(principal: TaskCaller, input: TaskQueryInput): Promise<TaskQueryResult>;
  read(principal: TaskCaller, input: TaskReadInput): Promise<TaskReadResult>;
  create(command: TaskCreateHostCommand): Promise<TaskCreateHostOutcome>;
  cancel(command: TaskCancelHostCommand): Promise<TaskCancelHostOutcome>;
  send(command: TaskSendHostCommand): Promise<TaskSendHostOutcome>;
  deliverReport(report: TaskReportDelivery): TaskReportDeliveryResult;
}
