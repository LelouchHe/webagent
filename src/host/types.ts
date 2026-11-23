export type McpWorkflowStatus =
  "running" | "idle" | "waiting" | "blocked" | "done";

export interface McpTaskHistoryRow {
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

export interface McpTaskListItem {
  id: string;
  title: string;
  relation: "self" | "parent" | "child";
  /**
   * Lifecycle status of the Task's last turn, matching `task_query`'s
   * `workflowStatus`. `done` is per turn, not a lifecycle terminal.
   */
  workflowStatus: McpWorkflowStatus;
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

export type McpTaskHistoryRecord = McpTaskHistoryRow;

export interface McpTaskQueryInput {
  taskId?: string;
  text?: string;
  range?: [number, number];
}

export interface McpTaskQueryResult {
  task_id: string;
  max_seq: number;
  rows: McpTaskHistoryRow[];
}

export interface McpTaskReadInput {
  taskId?: string;
  seqs: number[];
}

export interface McpTaskReadRow {
  seq: number;
  type: string;
  at: string;
  from: string;
  data: unknown;
}

export interface McpTaskReadResult {
  task_id: string;
  rows: McpTaskReadRow[];
}

export interface McpTaskCancelResult {
  accepted: true;
  taskId: string;
  status: "idle" | "cancelling" | "cancelled" | "superseded";
}

export interface McpTaskCreateInput {
  title: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  /**
   * The execution agent the child is created for, as configured at startup.
   * Omitted means "this Task's agent", which is the only value the caller can
   * always derive without knowing the deployment.
   */
  agent?: string;
}

export interface McpTaskCreateResult {
  taskId: string;
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
export interface McpCallerPrincipal {
  readonly taskId: string;
  readonly agentId: string;
  readonly generation: number | null;
  readonly initializing: boolean;
}

/**
 * Task operations supplied by the host behind task command entrypoints.
 *
 * Every operation takes the request's immutable caller principal: the write
 * operations re-check it at their own submission boundary (immediately before
 * the first side effect), so a rotation that lands while a request is in
 * flight cannot be written through.
 */
export interface TaskOps {
  list(principal: McpCallerPrincipal): McpTaskListItem[];
  query(
    principal: McpCallerPrincipal,
    input: McpTaskQueryInput,
  ): McpTaskQueryResult;
  read(
    principal: McpCallerPrincipal,
    input: McpTaskReadInput,
  ): McpTaskReadResult;
  cancel(
    principal: McpCallerPrincipal,
    targetTaskId: string,
    reason: string,
  ): Promise<McpTaskCancelResult>;
  create(
    principal: McpCallerPrincipal,
    input: McpTaskCreateInput,
  ): Promise<McpTaskCreateResult>;
  send(
    principal: McpCallerPrincipal,
    targetTaskId: string,
    body: string,
  ): Promise<void>;
  update(
    principal: McpCallerPrincipal,
    status: "waiting" | "blocked" | "done",
    body: string,
  ): Promise<{ note?: string }>;
}
