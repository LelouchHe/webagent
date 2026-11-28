import type {
  AgentCaller,
  Caller,
  TaskCancelOutcome,
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
  caller: Caller;
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

export interface LocalTaskRelationFact {
  id: string;
  parentId: string | null;
  title: string | null;
}

export interface TaskHistoryHostCommand<TInput> {
  principal: AgentCaller;
  input: TInput;
  /** Synchronous Core relation-visibility check for local history targets. */
  assertLocalTarget: (
    source: LocalTaskRelationFact | undefined,
    target: LocalTaskRelationFact | undefined,
  ) => void;
}

export interface RemoteSendCandidateFact {
  remoteRole: "child" | "parent";
  remoteHost: string;
  remoteTaskId: string;
  sourceExists: boolean;
  sourceTitle: string | null | undefined;
  targetTitle: string | null;
}

export interface SendLabels {
  sourceLabel: string;
  targetLabel: string;
}

export interface TaskSendHostCommand {
  principal: AgentCaller;
  targetTaskId: string;
  body: string;
  /** Core policy deciding whether an external-parent link matches the target. */
  matchesExternalParent: (remoteTaskId: string) => boolean;
  /** Core policy validating source existence and deriving remote send labels. */
  prepareRemoteSend: (candidate: RemoteSendCandidateFact) => SendLabels;
  /** Core policy validating local relation visibility and deriving labels. */
  prepareLocalSend: (
    source: LocalTaskRelationFact | undefined,
    target: LocalTaskRelationFact | undefined,
  ) => SendLabels;
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
  /**
   * Synchronous Core audit callback invoked inside the outer update transaction
   * when a local report delivery is enqueued.
   */
  recordLocalReport: (delivered: {
    messageId: string;
    deliveryId: string;
  }) => void;
}

export interface TaskReportDeliveryResult {
  drainLocalTargetTaskId?: string;
}

/**
 * Unified Host port consumed by Core (`src/task-ops.ts`).
 *
 * Core never chooses between local and remote execution: it passes structured
 * commands and synchronous policy/audit callbacks to `TaskHost`, and
 * `src/host/` internally routes between `src/host/local/` and `src/host/remote/`.
 */
export interface TaskHost {
  list(principal: AgentCaller): Promise<TaskListItem[]>;
  query(
    command: TaskHistoryHostCommand<TaskQueryInput>,
  ): Promise<TaskQueryResult>;
  read(command: TaskHistoryHostCommand<TaskReadInput>): Promise<TaskReadResult>;
  create(command: TaskCreateHostCommand): Promise<TaskCreateHostOutcome>;
  cancel(command: TaskCancelHostCommand): Promise<TaskCancelHostOutcome>;
  send(command: TaskSendHostCommand): Promise<TaskSendHostOutcome>;
  deliverReport(report: TaskReportDelivery): TaskReportDeliveryResult;
}
