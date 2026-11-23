import type { AgentCommandSnapshot, ConfigOption } from "../types.ts";

export type TaskWorkflowStatus =
  "running" | "idle" | "waiting" | "blocked" | "done";

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
  title: string;
  relation: "self" | "parent" | "child";
  /**
   * Lifecycle status of the Task's last turn, matching `task_query`'s
   * `workflowStatus`. `done` is per turn, not a lifecycle terminal.
   */
  workflowStatus: TaskWorkflowStatus;
  /**
   * Live execution source from the runtime: `agent` while an ACP turn or
   * delivery is running, `bash` while a user shell command owns the task, and
   * `idle` otherwise. Distinct from `workflowStatus`, which is the last typed
   * report, not execution truth.
   */
  executionState: "idle" | "agent" | "bash";
  /**
   * ISO-8601 time of the Task's latest qualifying agent-runtime event, or
   * null when none has been observed. Unlike `lastEventAt`, it ignores user
   * and system events, so it is a silence signal for a running turn.
   */
  lastAgentActivityAt: string | null;
  /**
   * `created_at` of the Task's most recent persisted event, any type — the
   * Task's own activity clock. Rendered as ISO-8601 UTC with an explicit `Z`,
   * like every other MCP timestamp. `null` when the Task has no persisted
   * events yet. It is a lag signal, not proof of work: a long silent tool call
   * can look stale while the Task is still running.
   */
  lastEventAt: string | null;
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

export interface TaskCreateInput {
  title?: string;
  cwd?: string;
  agentId?: unknown;
  model?: string;
  thinking?: string;
  parentId?: string;
  inheritFromTaskId?: string;
  source?: string;
  clientOpId?: string;
  workflowStatus?: TaskWorkflowStatus;
}

export type TaskCreateCaller =
  { kind: "user" } | { kind: "agent"; principal: TaskCaller };

export class TaskAgentNotConfiguredError extends Error {
  readonly agentId: string;

  constructor(agentId: string, message: string) {
    super(message);
    this.name = "TaskAgentNotConfiguredError";
    this.agentId = agentId;
  }
}

export class TaskAgentIdTypeError extends Error {
  constructor() {
    super("agentId must be a string");
    this.name = "TaskAgentIdTypeError";
  }
}

export class TaskAgentStartError extends Error {
  readonly agentId: string;
  readonly reason: string;
  readonly restMessage: string;

  constructor(
    agentId: string,
    reason: string,
    restMessage: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskAgentStartError";
    this.agentId = agentId;
    this.reason = reason;
    this.restMessage = restMessage;
  }
}

export interface TaskCreateResult {
  taskId: string;
  activation?: {
    cwd: string;
    cwdDisplay: string;
    title: string | null;
    parentId: string | null;
    parentAgentId: string | null;
    agentId: string | null;
    workflowStatus: TaskWorkflowStatus;
    source: string;
    configOptions: ConfigOption[];
    agentCommands: AgentCommandSnapshot;
  };
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
  list(principal: TaskCaller): TaskListItem[];
  query(principal: TaskCaller, input: TaskQueryInput): TaskQueryResult;
  read(principal: TaskCaller, input: TaskReadInput): TaskReadResult;
  cancel(
    principal: TaskCaller,
    targetTaskId: string,
    reason: string,
  ): Promise<TaskCancelOutcome>;
  create(
    caller: TaskCreateCaller,
    input: TaskCreateInput,
  ): Promise<TaskCreateResult>;
  send(
    principal: TaskCaller,
    targetTaskId: string,
    body: string,
  ): Promise<void>;
  update(
    principal: TaskCaller,
    status: "waiting" | "blocked" | "done",
    body: string,
  ): Promise<{ note?: string }>;
}
