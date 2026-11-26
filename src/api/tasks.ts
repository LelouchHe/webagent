import type { AgentCommandSnapshot, ConfigOption } from "../types.ts";
import type {
  TaskUpdateStatus,
  WorkflowStatus,
} from "../shared/workflow-status.ts";

export type TaskWorkflowStatus = WorkflowStatus;

export interface TaskHistoryRow {
  seq: number;
  type: string;
  bytes: number;
  group?: string;
  title?: string;
  field?: string;
  text?: string;
  content_shape?: "unknown";
  unprojected?: true;
}

export interface TaskListItem {
  id: string;
  title?: string | null;
  relation: "self" | "parent" | "child";
  /**
   * Lifecycle status of the Task's last turn, matching `task_query`'s
   * `workflowStatus`. `done` is per turn, not a lifecycle terminal.
   */
  workflowStatus?: TaskWorkflowStatus;
  /**
   * Live execution source from the runtime: `agent` while an ACP turn or
   * delivery is running, `bash` while a user shell command owns the task, and
   * `idle` otherwise. Distinct from `workflowStatus`, which is the last typed
   * report, not execution truth.
   */
  executionState?: "idle" | "agent" | "bash";
  /**
   * ISO-8601 time of the Task's latest qualifying agent-runtime event, or
   * null when none has been observed. Unlike `lastEventAt`, it ignores user
   * and system events, so it is a silence signal for a running turn.
   */
  lastAgentActivityAt?: string | null;
  /**
   * `created_at` of the Task's most recent persisted event, any type — the
   * Task's own activity clock. Rendered as ISO-8601 UTC with an explicit `Z`,
   * like every other MCP timestamp. `null` when the Task has no persisted
   * events yet. It is a lag signal, not proof of work: a long silent tool call
   * can look stale while the Task is still running.
   */
  lastEventAt?: string | null;
  host?: string | null;
  unreachable?: true;
}

export interface TaskQueryInput {
  taskId?: string;
  text?: string;
  range?: [number, number];
}

export interface TaskQueryResult {
  task_id: string;
  max_seq: number;
  rows: TaskHistoryRow[];
}

export interface TaskReadInput {
  taskId?: string;
  seqs: number[];
}

export interface TaskReadRow {
  seq: number;
  type: string;
  at: string;
  from: string;
  data: unknown;
}

export interface TaskReadResult {
  task_id: string;
  rows: TaskReadRow[];
}

export interface TaskCancelOutcome {
  accepted: true;
  taskId: string;
  status: "idle" | "cancelling" | "cancelled" | "superseded";
}

export interface TaskSendResult {
  messageId: string;
  deliveryId?: string;
  targetTaskId: string;
  targetLabel: string;
  sourceLabel: string;
}

export interface TaskReport {
  sourceTaskId: string;
  targetTaskId: string;
  targetIsLocal: boolean;
  status: Exclude<TaskUpdateStatus, "waiting">;
  body: string;
  sourceLabel: string;
  targetLabel: string;
}

export type TaskCancelCommand =
  | {
      kind: "user";
      taskId: string;
    }
  | {
      kind: "agent";
      principal: TaskCaller;
      targetTaskId: string;
      reason: string;
    };

export interface TaskCreateInput {
  title?: string;
  cwd?: string;
  agentId?: string;
  host?: string;
  model?: string;
  thinking?: string;
  parentId?: string;
  inheritFromTaskId?: string;
  source?: string;
  clientOpId?: string;
  workflowStatus?: TaskWorkflowStatus;
}

export type TaskCreateCaller =
  | { kind: "user" }
  | { kind: "agent"; principal: TaskCaller }
  | { kind: "host"; name: string };

abstract class CreateError extends Error {}

export class TaskAgentNotConfiguredError extends CreateError {
  readonly kind = "agent_not_configured";
  readonly agentId: string;

  constructor(agentId: string) {
    super("agent_not_configured");
    this.name = "TaskAgentNotConfiguredError";
    this.agentId = agentId;
  }
}

export class TaskAgentStartError extends CreateError {
  readonly kind = "agent_start";
  readonly agentId: string;
  readonly reason: string;
  readonly unavailable: boolean;

  constructor(
    agentId: string,
    reason: string,
    unavailable: boolean,
    options?: ErrorOptions,
  ) {
    super("agent_start_failed", options);
    this.name = "TaskAgentStartError";
    this.agentId = agentId;
    this.reason = reason;
    this.unavailable = unavailable;
  }
}

export class TaskCreateConfigError extends CreateError {
  readonly kind = "config";
  readonly reason: "unsupported" | "invalid";
  readonly logicalId: "model" | "thinking";
  readonly agentId: string;
  readonly requestedValue: string;
  readonly supportedValues: readonly string[];
  readonly currentValue: string | null;

  constructor(
    details: {
      reason: "unsupported" | "invalid";
      logicalId: "model" | "thinking";
      agentId: string;
      requestedValue: string;
      supportedValues: readonly string[];
      currentValue: string | null;
    },
    options?: ErrorOptions,
  ) {
    super("task_config_override_failed", options);
    this.name = "TaskCreateConfigError";
    this.reason = details.reason;
    this.logicalId = details.logicalId;
    this.agentId = details.agentId;
    this.requestedValue = details.requestedValue;
    this.supportedValues = details.supportedValues;
    this.currentValue = details.currentValue;
  }
}

export interface TaskCreateResult {
  task: {
    id: string;
    title: string | null;
    agentId: string;
    cwd: string;
    model: string | null;
    thinking: string | null;
    parentId: string | null;
    workflowStatus: TaskWorkflowStatus;
    source: string;
  };
  session?: {
    cwdDisplay: string;
    parentAgentId: string | null;
    configOptions: ConfigOption[];
    agentCommands: AgentCommandSnapshot;
  };
}

export interface RemoteTaskCreateInput {
  agentId: string;
  parentId: string;
  title?: string;
  cwd?: string;
  source: string;
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
  assertRemoteCaller: () => void;
}

export interface TaskCreateHost {
  create(command: TaskCreateHostCommand): Promise<TaskCreateResult>;
}

export interface RemoteTaskCreateTransport {
  create(host: string, input: RemoteTaskCreateInput): Promise<TaskCreateResult>;
}

export class TaskHostNotConfiguredError extends CreateError {
  readonly kind = "host_not_configured";
  readonly host: string;

  constructor(host: string) {
    super("host_not_configured");
    this.name = "TaskHostNotConfiguredError";
    this.host = host;
  }
}

export class TaskRemoteCreateRejectedError extends CreateError {
  readonly kind = "rejected";
  readonly host: string;
  readonly status: number;
  readonly reason: string;

  constructor(
    host: string,
    status: number,
    reason: string,
    options?: ErrorOptions,
  ) {
    super("remote_task_create_rejected", options);
    this.name = "TaskRemoteCreateRejectedError";
    this.host = host;
    this.status = status;
    this.reason = reason;
  }
}

export class TaskRemoteCreateUnknownError extends CreateError {
  readonly kind = "unknown";
  readonly host: string;
  readonly reason: string;

  constructor(host: string, reason: string, options?: ErrorOptions) {
    super("remote_task_create_result_unknown", options);
    this.name = "TaskRemoteCreateUnknownError";
    this.host = host;
    this.reason = reason;
  }
}

export class TaskRemoteCreateNotSentError extends CreateError {
  readonly kind = "not_sent";
  readonly host: string;
  readonly reason: string;

  constructor(host: string, reason: string, options?: ErrorOptions) {
    super("remote_task_create_not_sent", options);
    this.name = "TaskRemoteCreateNotSentError";
    this.host = host;
    this.reason = reason;
  }
}

export class TaskRemoteCreatePartialSuccessError extends CreateError {
  readonly kind = "partial_success";
  readonly host: string;
  readonly remoteTaskId: string;

  constructor(host: string, remoteTaskId: string, options?: ErrorOptions) {
    super("remote_task_create_partial_success", options);
    this.name = "TaskRemoteCreatePartialSuccessError";
    this.host = host;
    this.remoteTaskId = remoteTaskId;
  }
}

export class TaskRemoteCreateConfigError extends CreateError {
  readonly kind = "remote_config";
  readonly logicalId: "model" | "thinking";

  constructor(logicalId: "model" | "thinking") {
    super("remote_task_create_config_unsupported");
    this.name = "TaskRemoteCreateConfigError";
    this.logicalId = logicalId;
  }
}

export class TaskCreateInputError extends CreateError {
  readonly kind = "input";
  readonly code: string;
  readonly clientMessage: string;

  constructor(code: string, clientMessage: string) {
    super(code);
    this.name = "TaskCreateInputError";
    this.code = code;
    this.clientMessage = clientMessage;
  }
}

export type TaskCreateError =
  | TaskAgentNotConfiguredError
  | TaskAgentStartError
  | TaskCreateConfigError
  | TaskCreateInputError
  | TaskHostNotConfiguredError
  | TaskRemoteCreateConfigError
  | TaskRemoteCreateRejectedError
  | TaskRemoteCreateNotSentError
  | TaskRemoteCreateUnknownError
  | TaskRemoteCreatePartialSuccessError;

export function isTaskCreateError(error: unknown): error is TaskCreateError {
  return error instanceof CreateError;
}

/**
 * The caller identity of one MCP request, captured once at the endpoint and
 * never mutated.
 *
 * `taskId` is the agent's own task, `agentId` the agent that capability was
 * minted for, and `generation` the execution generation the *token* was
 * promoted for. That generation is the authorization: a request that outlives
 * a rotation must not write even though its token authenticated, and an old
 * token must not inherit the task's newer generation. `initializing` marks the
 * pending window of a session creation, where only the protocol handshake is
 * allowed.
 */
export interface TaskCaller {
  readonly taskId: string;
  readonly agentId: string;
  readonly generation: number | null;
  readonly initializing: boolean;
}

/**
 * Task operations supplied by the host behind task command entrypoints.
 *
 * Agent operations take the request's immutable caller principal; create also
 * accepts a user caller. Agent writes re-check that principal at their own
 * submission boundary (immediately before the first side effect), so a
 * rotation that lands while a request is in flight cannot be written through.
 */
export interface TaskOps {
  list(principal: TaskCaller): Promise<TaskListItem[]>;
  query(principal: TaskCaller, input: TaskQueryInput): Promise<TaskQueryResult>;
  read(principal: TaskCaller, input: TaskReadInput): Promise<TaskReadResult>;
  cancel(command: TaskCancelCommand): Promise<TaskCancelOutcome>;
  create(
    caller: TaskCreateCaller,
    input: TaskCreateInput,
  ): Promise<TaskCreateResult>;
  send(
    principal: TaskCaller,
    targetTaskId: string,
    body: string,
    record?: (result: TaskSendResult) => void,
  ): Promise<TaskSendResult>;
  update(
    principal: TaskCaller,
    status: TaskUpdateStatus,
    body: string,
    recordReport?: (report: TaskReport) => void,
  ): Promise<{ note?: string }>;
}
