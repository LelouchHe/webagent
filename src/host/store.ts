import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  emptyExecutionSlot,
  type CollaborationActor,
  type CollaborationDeliveryRow,
  type CollaborationMessageRow,
  type DeliveryClaimMetadata,
  type Store,
} from "../store.ts";
import { buildCollaborationSystemMessage } from "../collaboration-message.ts";
import { formatFieldBlock } from "../shared/field-block.ts";
import type {
  DeliveryRequest,
  LocationProvider,
  TaskDescription,
} from "../task-locator.ts";
import type { CollaborationRelation } from "../task-collaboration.ts";
import { reduceObligationOutcome } from "../obligation-outcomes.ts";

export type HostMessageKind =
  "collaboration" | "done" | "blocked" | "runtime_notice";

export interface HostExternalSource {
  task_id: string;
  credential_hash: string;
  parent_task_id: string;
  create_key: string;
  request_hash: string;
  created_at: number;
}
export interface HostEdge {
  id: string;
  parent_task_id: string;
  host_name: string;
  remote_task_id: string;
  display_title: string;
  credential_hash: string;
  create_key: string;
  request_hash: string;
  status: "active" | "removed" | "abandoned";
  created_at: number;
  ended_at: number | null;
}
export interface HostDispatch {
  delivery_id: string;
  edge_id: string;
  state: "pending" | "handed_off" | "terminal";
  ended_reason: string | null;
  created_at: number;
  ended_at: number | null;
}
export interface HostEnvelope {
  id: string;
  owner_task_id: string;
  parent_task_id: string;
  kind: HostMessageKind;
  body: string;
  runtime_kind?: string | null;
  reason?: string | null;
  queued_at: number;
}
export interface HostReportReceiptInput {
  hostName: string;
  credentialHash: string;
  ownerMessageId: string;
  ownerTaskId: string;
  parentTaskId: string;
  kind: HostMessageKind;
  body: string;
  runtimeKind?: string | null;
  reason?: string | null;
}

export class HostStore implements LocationProvider {
  private readonly store: Store;
  private readonly db: Database.Database;
  private factsPresent = false;
  private readonly committedObservers: Array<
    (recipientTaskId: string) => void
  > = [];

  constructor(store: Store) {
    this.store = store;
    this.db = store.database();
    this.initializeSchema();
    this.factsPresent =
      this.db
        .prepare(
          "SELECT 1 FROM host_external_sources UNION ALL SELECT 1 FROM host_edges LIMIT 1",
        )
        .get() !== undefined;
    store.registerDeliveryClaimMetadataProvider((recipientTaskId) =>
      this.claimMetadata(recipientTaskId),
    );
    store.registerDeliveryFailurePolicy(
      (change) =>
        !this.isTransportDelivery(change.deliveryId) &&
        !this.isReportMessage(change.messageId),
    );
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_external_sources (task_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, parent_task_id TEXT NOT NULL, create_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (credential_hash, create_key));
      CREATE INDEX IF NOT EXISTS idx_host_external_sources_credential ON host_external_sources (credential_hash);
      CREATE TABLE IF NOT EXISTS host_received_dispatches (credential_hash TEXT NOT NULL, remote_message_id TEXT NOT NULL, local_message_id TEXT NOT NULL, request_hash TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (credential_hash, remote_message_id));
      CREATE INDEX IF NOT EXISTS idx_host_received_dispatches_local ON host_received_dispatches (local_message_id);
      CREATE TABLE IF NOT EXISTS host_edges (id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL, host_name TEXT NOT NULL, remote_task_id TEXT NOT NULL, display_title TEXT NOT NULL, credential_hash TEXT NOT NULL, create_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','removed','abandoned')), created_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(parent_task_id, host_name, credential_hash, create_key));
      CREATE INDEX IF NOT EXISTS idx_host_edges_parent_status ON host_edges (parent_task_id, status);
      CREATE TABLE IF NOT EXISTS host_dispatches (delivery_id TEXT PRIMARY KEY, edge_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','handed_off','terminal')), ended_reason TEXT, created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_host_dispatches_edge_state ON host_dispatches (edge_id, state);
      CREATE TABLE IF NOT EXISTS host_wake_hints (edge_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host_message_types (message_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('collaboration','done','blocked','runtime_notice')), runtime_kind TEXT, reason TEXT);
      CREATE TABLE IF NOT EXISTS host_report_receipts (host_name TEXT NOT NULL, credential_hash TEXT NOT NULL, owner_message_id TEXT NOT NULL, local_message_id TEXT, edge_id TEXT NOT NULL, parent_task_id TEXT NOT NULL, result TEXT NOT NULL CHECK (result IN ('queued','parent_deleted')), received_at INTEGER NOT NULL, PRIMARY KEY(host_name, credential_hash, owner_message_id));
    `);
  }

  private isTransportDelivery(deliveryId: string): boolean {
    return this.factsPresent && this.getHostDispatch(deliveryId) !== undefined;
  }
  private isReportMessage(messageId: string): boolean {
    return this.factsPresent && this.isHostReportMessage(messageId);
  }
  private claimMetadata(
    recipientTaskId: string,
  ): Map<string, DeliveryClaimMetadata> {
    if (!this.factsPresent) return new Map();
    const rows = this.db
      .prepare(
        "SELECT d.id, es.parent_task_id, he.display_title, CASE WHEN h.local_message_id IS NOT NULL THEN 1 ELSE 0 END AS inbound_external, he.host_name IS NOT NULL AS returned_external FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id LEFT JOIN host_received_dispatches h ON h.local_message_id = m.id LEFT JOIN host_external_sources es ON es.task_id = d.recipient_task_id AND es.credential_hash = h.credential_hash LEFT JOIN host_report_receipts hr ON hr.local_message_id = m.id LEFT JOIN host_edges he ON he.id = hr.edge_id WHERE d.recipient_task_id = ? AND d.status = 'queued'",
      )
      .all(recipientTaskId) as Array<{
      id: string;
      parent_task_id: string | null;
      display_title: string | null;
      inbound_external: number;
      returned_external: number;
    }>;
    const result = new Map<string, DeliveryClaimMetadata>();
    for (const row of rows) {
      if (row.inbound_external && row.parent_task_id)
        result.set(row.id, {
          accountSourceTaskId: row.parent_task_id,
          sourceEndpointLabel: "External task " + row.parent_task_id,
          sourcePresentation: { externalSource: true },
        });
      else if (row.returned_external && row.display_title)
        result.set(row.id, {
          sourceEndpointLabel: row.display_title,
          sourcePresentation: { externalSource: true },
        });
    }
    return result;
  }

  onCommitted(observer: (recipientTaskId: string) => void): void {
    this.committedObservers.push(observer);
  }

  deliveryCommitAction(
    deliveryId: string,
  ): { edgeId: string } | { credentialHash: string } | null {
    if (!this.factsPresent) return null;
    const dispatch = this.db
      .prepare(`SELECT edge_id FROM host_dispatches WHERE delivery_id = ?`)
      .get(deliveryId) as { edge_id: string } | undefined;
    if (dispatch) return { edgeId: dispatch.edge_id };
    const outbound = this.db
      .prepare(
        `SELECT es.credential_hash
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN host_external_sources es
           ON es.task_id = m.source_task_id
          AND es.parent_task_id = m.direct_target_task_id
         WHERE d.id = ? AND d.status = 'queued'`,
      )
      .get(deliveryId) as { credential_hash: string } | undefined;
    return outbound ? { credentialHash: outbound.credential_hash } : null;
  }

  relation(sourceId: string, targetId: string): CollaborationRelation | null {
    if (!this.factsPresent) return null;
    if (this.findHostEdgeForParent(targetId, sourceId)) return "child";
    const external = this.getHostExternalSource(sourceId);
    const source = this.store.getTask(sourceId);
    return source?.parent_id === null && external?.parent_task_id === targetId
      ? "parent"
      : null;
  }

  parentOf(taskId: string): string | null {
    if (!this.factsPresent) return null;
    return this.getHostExternalSource(taskId)?.parent_task_id ?? null;
  }

  childrenOf(taskId: string): string[] {
    if (!this.factsPresent) return [];
    return this.listHostEdgesForParent(taskId).map(
      (edge) => edge.remote_task_id,
    );
  }

  describe(taskId: string): TaskDescription | null {
    if (!this.factsPresent) return null;
    const edge = this.db
      .prepare(
        `SELECT * FROM host_edges
         WHERE remote_task_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as HostEdge | undefined;
    if (edge) {
      return {
        id: edge.remote_task_id,
        title: edge.display_title,
        relation: "child",
        local: false,
        presentation: { external: true, hostLabel: edge.host_name },
      };
    }
    const source = this.db
      .prepare(
        `SELECT task_id, parent_task_id FROM host_external_sources
         WHERE parent_task_id = ? LIMIT 1`,
      )
      .get(taskId) as { task_id: string; parent_task_id: string } | undefined;
    if (source) {
      return {
        id: source.parent_task_id,
        title: source.parent_task_id,
        relation: "parent",
        local: false,
        presentation: { external: true },
      };
    }
    return null;
  }

  hasChildWakeSource(parentId: string): boolean {
    return this.factsPresent && this.hasOpenHostDispatch(parentId);
  }

  canEnqueueDelivery(request: DeliveryRequest): boolean {
    if (!this.factsPresent) return false;
    if (
      request.kind === "dispatch" &&
      this.findHostEdgeForParent(request.targetTaskId, request.sourceTaskId)
    ) {
      return true;
    }
    if (
      request.kind === "message" &&
      this.store.getTask(request.sourceTaskId)?.parent_id === null
    ) {
      return (
        this.getHostExternalSource(request.sourceTaskId)?.parent_task_id ===
        request.targetTaskId
      );
    }
    return (
      this.getHostExternalSource(request.sourceTaskId)?.parent_task_id ===
      request.targetTaskId
    );
  }

  enqueueDelivery(request: DeliveryRequest): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  } | null {
    if (!this.factsPresent) return null;
    const edge = this.findHostEdgeForParent(
      request.targetTaskId,
      request.sourceTaskId,
    );
    if (edge && request.kind === "dispatch") {
      return this.createRemoteDispatch({
        messageId: request.messageId,
        deliveryId: request.deliveryId,
        parentTaskId: request.sourceTaskId,
        edge,
        body: request.body,
      });
    }
    const sourceTask = this.store.getTask(request.sourceTaskId);
    const source =
      request.kind === "message" && sourceTask?.parent_id !== null
        ? null
        : this.getHostExternalSource(request.sourceTaskId);
    if (source?.parent_task_id !== request.targetTaskId) return null;
    const sourceExists = this.store.getTask(request.sourceTaskId) !== undefined;
    return this.insertHostOutboundMessage({
      messageId: request.messageId,
      deliveryId: request.deliveryId,
      sourceTaskId: request.sourceTaskId,
      targetTaskId: request.targetTaskId,
      sourceActor: request.kind === "notice" ? "system" : "agent",
      body: request.body,
      kind:
        request.kind === "message"
          ? "collaboration"
          : request.kind === "update"
            ? (request.updateStatus ?? "done")
            : "runtime_notice",
      runtimeKind: request.runtimeKind,
      reason: request.reason,
      writeSourceEvent: sourceExists,
      projectSource: sourceExists,
      targetLabel: request.targetTaskId,
    });
  }

  getHostExternalSource(taskId: string): HostExternalSource | undefined {
    return this.db
      .prepare("SELECT * FROM host_external_sources WHERE task_id = ?")
      .get(taskId) as HostExternalSource | undefined;
  }

  getHostCreateResult(
    credentialHash: string,
    createKey: string,
    requestHash: string,
  ): { status: "reused"; taskId: string } | { status: "conflict" } | null {
    const existing = this.db
      .prepare(
        `SELECT task_id, request_hash FROM host_external_sources
         WHERE credential_hash = ? AND create_key = ?`,
      )
      .get(credentialHash, createKey) as
      { task_id: string; request_hash: string } | undefined;
    if (!existing) return null;
    return existing.request_hash === requestHash
      ? { status: "reused", taskId: existing.task_id }
      : { status: "conflict" };
  }

  createHostTask(input: {
    credentialHash: string;
    parentTaskId: string;
    createKey: string;
    requestHash: string;
    agentId: string;
    cwd: string;
    title: string;
    model?: string | null;
    thinking?: string | null;
  }):
    { status: "created" | "reused"; taskId: string } | { status: "conflict" } {
    const taskId = randomUUID();
    const now = Date.now();
    const result = this.store.writeBindings(() => {
      const existing = this.getHostCreateResult(
        input.credentialHash,
        input.createKey,
        input.requestHash,
      );
      if (existing) return existing;
      if (
        this.store.getTaskIncludingDeleted(input.parentTaskId) ||
        this.db
          .prepare("SELECT 1 FROM host_edges WHERE remote_task_id = ? LIMIT 1")
          .get(input.parentTaskId)
      ) {
        return { status: "conflict" as const };
      }
      if (
        this.store.getTaskIncludingDeleted(taskId) ||
        this.db
          .prepare("SELECT 1 FROM host_edges WHERE remote_task_id = ? LIMIT 1")
          .get(taskId)
      ) {
        throw new Error("host_task_id_conflict");
      }
      const task = this.store.createTaskInTransaction(
        taskId,
        input.cwd,
        "host",
        input.agentId,
        emptyExecutionSlot(taskId),
        null,
        {
          title: input.title,
          detached: true,
          mode: "agent",
        },
      );
      if (input.model !== undefined && input.model !== null) {
        this.store.updateTaskConfig(task.id, "model", input.model);
      }
      if (input.thinking !== undefined && input.thinking !== null) {
        this.store.updateTaskConfig(
          task.id,
          "reasoning_effort",
          input.thinking,
        );
      }
      this.db
        .prepare(
          `INSERT INTO host_external_sources
           (task_id, credential_hash, parent_task_id, create_key, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          input.credentialHash,
          input.parentTaskId,
          input.createKey,
          input.requestHash,
          now,
        );
      this.store.saveEvent(
        taskId,
        "system_message",
        {
          kind: "task_created_host",
          title: "Remote task created",
          body: `Parent task: ${input.parentTaskId}`,
          externalParentTaskId: input.parentTaskId,
        },
        { from_ref: "system" },
      );
      return { status: "created" as const, taskId };
    });
    if (result.status !== "conflict") this.factsPresent = true;
    return result;
  }

  receiveHostDispatch(input: {
    credentialHash: string;
    remoteMessageId: string;
    requestHash: string;
    targetTaskId: string;
    body: string;
  }):
    | {
        status: "accepted";
        localMessageId: string;
        message?: CollaborationMessageRow;
        delivery?: CollaborationDeliveryRow;
      }
    | { status: "conflict" }
    | { status: "target_not_found" }
    | { status: "forbidden" } {
    const localMessageId = randomUUID();
    const deliveryId = randomUUID();
    const now = Date.now();
    const created = this.db.transaction(() => {
      const duplicate = this.db
        .prepare(
          `SELECT local_message_id, request_hash FROM host_received_dispatches
           WHERE credential_hash = ? AND remote_message_id = ?`,
        )
        .get(input.credentialHash, input.remoteMessageId) as
        { local_message_id: string; request_hash: string } | undefined;
      if (duplicate) {
        return duplicate.request_hash === input.requestHash
          ? {
              status: "accepted" as const,
              localMessageId: duplicate.local_message_id,
            }
          : { status: "conflict" as const };
      }
      const task = this.store.getTaskIncludingDeleted(input.targetTaskId);
      const source = this.getHostExternalSource(input.targetTaskId);
      if (task?.deleted_at !== null) {
        return { status: "target_not_found" as const };
      }
      if (
        source?.credential_hash !== input.credentialHash ||
        source.task_id === source.parent_task_id
      ) {
        return { status: "forbidden" as const };
      }
      const createdMessage = this.store.enqueueDeliveryRows({
        messageId: localMessageId,
        deliveryId,
        sourceTaskId: source.parent_task_id,
        directTargetTaskId: input.targetTaskId,
        sourceActor: "agent",
        body: input.body,
        createdAt: now,
        projections: [{ taskId: input.targetTaskId, role: "target" }],
      });
      this.db
        .prepare(
          `INSERT INTO host_received_dispatches
           (credential_hash, remote_message_id, local_message_id, request_hash, received_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.credentialHash,
          input.remoteMessageId,
          localMessageId,
          input.requestHash,
          now,
        );
      return {
        status: "accepted" as const,
        localMessageId,
        message: createdMessage.message,
        delivery: createdMessage.delivery,
      };
    })();
    if (created.status === "accepted") {
      this.factsPresent = true;
      for (const observer of this.committedObservers) {
        observer(input.targetTaskId);
      }
    }
    return created;
  }

  getHostEdge(id: string): HostEdge | undefined {
    return this.db.prepare("SELECT * FROM host_edges WHERE id = ?").get(id) as
      HostEdge | undefined;
  }

  findHostEdge(input: {
    hostName: string;
    credentialHash: string;
    remoteTaskId: string;
    parentTaskId: string;
  }): HostEdge | undefined {
    return this.db
      .prepare(
        `SELECT * FROM host_edges
         WHERE host_name = ? AND credential_hash = ?
           AND remote_task_id = ? AND parent_task_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(
        input.hostName,
        input.credentialHash,
        input.remoteTaskId,
        input.parentTaskId,
      ) as HostEdge | undefined;
  }

  findHostEdgeForParent(
    targetTaskId: string,
    parentTaskId: string,
  ): HostEdge | undefined {
    return this.db
      .prepare(
        `SELECT * FROM host_edges
         WHERE remote_task_id = ? AND parent_task_id = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(targetTaskId, parentTaskId) as HostEdge | undefined;
  }

  listHostEdgesForParent(parentTaskId: string): HostEdge[] {
    return this.db
      .prepare(
        `SELECT * FROM host_edges
         WHERE parent_task_id = ? AND status = 'active'
         ORDER BY display_title, remote_task_id`,
      )
      .all(parentTaskId) as HostEdge[];
  }

  siblingTitleExists(parentTaskId: string, title: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM tasks
           WHERE parent_id = ? AND deleted_at IS NULL AND title = ?
           UNION ALL
           SELECT 1 FROM host_edges
           WHERE parent_task_id = ? AND status = 'active' AND display_title = ?
           LIMIT 1`,
        )
        .get(parentTaskId, title, parentTaskId, title) !== undefined
    );
  }

  createHostEdge(input: {
    parentTaskId: string;
    hostName: string;
    remoteTaskId: string;
    title: string;
    credentialHash: string;
    createKey: string;
    requestHash: string;
    event: {
      title: string;
      body: string;
      kind: string;
      taskId: string;
      taskTitle: string;
      agentId: string;
      cwd: string;
      model: string | null;
      thinking: string | null;
    };
  }): { status: "created" | "conflict"; edge: HostEdge | null } {
    const id = randomUUID();
    const now = Date.now();
    const created = this.db.transaction(() => {
      const parent = this.store.getTask(input.parentTaskId);
      if (!parent) throw new Error("parent_not_found");
      if (this.store.getTaskIncludingDeleted(input.remoteTaskId)) {
        throw new Error("host_task_id_conflicts_with_local");
      }
      if (this.getHostExternalSource(input.remoteTaskId)) {
        throw new Error("host_task_id_conflicts_with_external_parent");
      }
      const ownedElsewhere = this.db
        .prepare(
          `SELECT 1 FROM host_edges
             WHERE remote_task_id = ?
               AND NOT (
                 host_name = ? AND credential_hash = ? AND
                 parent_task_id = ? AND create_key = ?
               )
             LIMIT 1`,
        )
        .get(
          input.remoteTaskId,
          input.hostName,
          input.credentialHash,
          input.parentTaskId,
          input.createKey,
        );
      if (ownedElsewhere) {
        return { status: "conflict" as const, edge: null };
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM host_edges
           WHERE parent_task_id = ? AND host_name = ?
             AND credential_hash = ? AND create_key = ?`,
        )
        .get(
          input.parentTaskId,
          input.hostName,
          input.credentialHash,
          input.createKey,
        ) as HostEdge | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          return { status: "conflict" as const, edge: existing };
        }
        return {
          status: "created" as const,
          edge: existing,
        };
      }
      if (this.siblingTitleExists(input.parentTaskId, input.title)) {
        return { status: "conflict" as const, edge: null };
      }
      this.db
        .prepare(
          `INSERT INTO host_edges
           (id, parent_task_id, host_name, remote_task_id, display_title,
            credential_hash, create_key, request_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          input.parentTaskId,
          input.hostName,
          input.remoteTaskId,
          input.title,
          input.credentialHash,
          input.createKey,
          input.requestHash,
          now,
        );
      this.store.saveEvent(
        input.parentTaskId,
        "system_message",
        {
          ...input.event,
          sourceTaskId: input.parentTaskId,
          targetTaskId: input.remoteTaskId,
          externalHost: input.hostName,
        },
        { from_ref: "agent" },
      );
      return {
        status: "created" as const,
        edge: this.getHostEdge(id)!,
      };
    })();
    if (created.status === "created") this.factsPresent = true;
    return created;
  }

  private insertHostOutboundMessage(input: {
    messageId?: string;
    deliveryId?: string;
    sourceTaskId: string;
    targetTaskId: string;
    sourceActor: CollaborationActor;
    body: string;
    kind: HostMessageKind;
    runtimeKind?: string | null;
    reason?: string | null;
    writeSourceEvent?: boolean;
    projectSource?: boolean;
    sourceLabel?: string;
    targetLabel?: string;
  }): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  } {
    const messageId = input.messageId ?? randomUUID();
    const deliveryId = input.deliveryId ?? randomUUID();
    const now = Date.now();
    const created = this.store.enqueueDeliveryRows({
      messageId,
      deliveryId,
      sourceTaskId: input.sourceTaskId,
      directTargetTaskId: input.targetTaskId,
      sourceActor: input.sourceActor,
      body: input.body,
      createdAt: now,
      projections:
        input.projectSource === false
          ? []
          : [{ taskId: input.sourceTaskId, role: "source" }],
    });
    this.db
      .prepare(
        `INSERT INTO host_message_types
         (message_id, kind, runtime_kind, reason) VALUES (?, ?, ?, ?)`,
      )
      .run(
        messageId,
        input.kind,
        input.runtimeKind ?? null,
        input.reason ?? null,
      );
    if (input.writeSourceEvent) {
      this.store.saveEvent(
        input.sourceTaskId,
        "system_message",
        buildCollaborationSystemMessage({
          messageId,
          sourceTaskId: input.sourceTaskId,
          sourceLabel:
            input.sourceLabel ??
            this.store.getTaskIncludingDeleted(input.sourceTaskId)?.title ??
            input.sourceTaskId.slice(0, 8),
          targetTaskId: input.targetTaskId,
          targetLabel: input.targetLabel ?? input.targetTaskId.slice(0, 8),
          role: "source",
          body: input.body,
          ...(input.kind === "runtime_notice"
            ? { runtimeMessage: "task_outcome_notice" as const }
            : {}),
        }),
        { from_ref: `msg:${messageId}` },
      );
    }
    return created;
  }

  listHostOutbox(credentialHash: string, limit = 100): HostEnvelope[] {
    return this.db
      .prepare(
        `SELECT m.id, m.source_task_id AS owner_task_id,
                m.direct_target_task_id AS parent_task_id,
                mt.kind, m.body, mt.runtime_kind, mt.reason, d.queued_at
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN host_message_types mt ON mt.message_id = m.id
         JOIN host_external_sources es
           ON es.task_id = m.source_task_id
          AND es.parent_task_id = m.direct_target_task_id
         WHERE es.credential_hash = ? AND d.status = 'queued'
         ORDER BY d.queued_at, d.rowid
         LIMIT ?`,
      )
      .all(credentialHash, limit) as HostEnvelope[];
  }

  ackHostMessage(
    credentialHash: string,
    messageId: string,
  ): { status: "acked" | "not_found" | "forbidden" } {
    const row = this.db
      .prepare(
        `SELECT d.id AS delivery_id, es.credential_hash
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN host_external_sources es
           ON es.task_id = m.source_task_id
          AND es.parent_task_id = m.direct_target_task_id
         WHERE m.id = ? LIMIT 1`,
      )
      .get(messageId) as
      { delivery_id: string; credential_hash: string } | undefined;
    if (!row) return { status: "not_found" };
    if (row.credential_hash !== credentialHash) return { status: "forbidden" };
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?)
         WHERE id = ? AND status = 'queued'`,
      )
      .run(Date.now(), row.delivery_id);
    this.store.broadcastDeliveryStatus([row.delivery_id]);
    return { status: "acked" };
  }

  createRemoteDispatch(input: {
    messageId?: string;
    deliveryId?: string;
    parentTaskId: string;
    edge: HostEdge;
    body: string;
  }): { message: CollaborationMessageRow; delivery: CollaborationDeliveryRow } {
    return this.db.transaction(() => {
      const parent = this.store.requireLiveTask(input.parentTaskId);
      if (
        input.edge.parent_task_id !== parent.id ||
        input.edge.status !== "active"
      ) {
        throw new Error("target_not_allowed");
      }
      const messageId = input.messageId ?? randomUUID();
      const deliveryId = input.deliveryId ?? randomUUID();
      const now = Date.now();
      const created = this.store.enqueueDeliveryRows({
        messageId,
        deliveryId,
        sourceTaskId: parent.id,
        directTargetTaskId: input.edge.remote_task_id,
        sourceActor: "agent",
        body: input.body,
        createdAt: now,
        projections: [{ taskId: parent.id, role: "source" }],
      });
      this.store.saveEvent(
        parent.id,
        "system_message",
        buildCollaborationSystemMessage({
          messageId,
          sourceTaskId: parent.id,
          sourceLabel: parent.title ?? parent.id,
          targetTaskId: input.edge.remote_task_id,
          targetLabel: input.edge.display_title,
          role: "source",
          body: input.body,
          externalTargetHost: input.edge.host_name,
        }),
        { from_ref: `msg:${messageId}` },
      );
      this.db
        .prepare(
          `INSERT INTO host_dispatches
           (delivery_id, edge_id, state, created_at)
           VALUES (?, ?, 'pending', ?)`,
        )
        .run(deliveryId, input.edge.id, now);
      this.db
        .prepare(
          `INSERT INTO host_wake_hints (edge_id, created_at)
           VALUES (?, ?) ON CONFLICT(edge_id) DO NOTHING`,
        )
        .run(input.edge.id, now);
      return created;
    })();
  }

  nextHostDispatch(edgeId: string):
    | {
        dispatch: HostDispatch;
        edge: HostEdge;
        delivery: CollaborationDeliveryRow;
        message: CollaborationMessageRow;
      }
    | undefined {
    const dispatch = this.db
      .prepare(
        `SELECT hd.* FROM host_dispatches hd
         JOIN deliveries d ON d.id = hd.delivery_id
         WHERE hd.edge_id = ? AND hd.state = 'pending'
         ORDER BY d.queued_at, d.rowid LIMIT 1`,
      )
      .get(edgeId) as HostDispatch | undefined;
    if (!dispatch) return undefined;
    const edge = this.getHostEdge(edgeId);
    const delivery = this.store.getCollaborationDelivery(dispatch.delivery_id);
    if (!edge || !delivery) return undefined;
    const message = this.store.getCollaborationMessage(delivery.message_id);
    if (!message) return undefined;
    return { dispatch, edge, delivery, message };
  }

  markHostDispatchHandedOff(deliveryId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE host_dispatches SET state = 'handed_off'
           WHERE delivery_id = ? AND state = 'pending'`,
        )
        .run(deliveryId);
      this.db
        .prepare(
          `UPDATE deliveries SET status = 'delivered', delivered_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(Date.now(), deliveryId);
    })();
    this.store.broadcastDeliveryStatus([deliveryId]);
  }

  finishHostDispatch(deliveryId: string, reason: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE host_dispatches
           SET state = 'terminal', ended_reason = ?, ended_at = ?
           WHERE delivery_id = ?`,
        )
        .run(reason, Date.now(), deliveryId);
      this.db
        .prepare(
          `UPDATE deliveries
           SET status = 'failed', failed_at = ?, failure_reason = ?, delivered_at = NULL
           WHERE id = ? AND status = 'queued'`,
        )
        .run(Date.now(), reason, deliveryId);
    })();
    this.store.broadcastDeliveryStatus([deliveryId]);
  }

  failHostEdgeTargetNotFound(deliveryId: string): {
    failedDeliveryIds: string[];
    noticeRecipientTaskId: string | null;
  } {
    const result = this.db.transaction(() => {
      const dispatch = this.db
        .prepare(
          `SELECT hd.edge_id, he.parent_task_id, he.remote_task_id,
                  he.display_title
           FROM host_dispatches hd
           JOIN host_edges he ON he.id = hd.edge_id
           WHERE hd.delivery_id = ? AND hd.state = 'pending'`,
        )
        .get(deliveryId) as
        | {
            edge_id: string;
            parent_task_id: string;
            remote_task_id: string;
            display_title: string;
          }
        | undefined;
      if (!dispatch) {
        return {
          failedDeliveryIds: [] as string[],
          noticeRecipientTaskId: null,
        };
      }
      const now = Date.now();
      const trigger = this.store.getCollaborationDelivery(deliveryId);
      const triggerMessage = trigger
        ? this.store.getCollaborationMessage(trigger.message_id)
        : undefined;
      const outcome =
        trigger && triggerMessage
          ? reduceObligationOutcome({
              kind: "delivery_failed",
              change: {
                deliveryId: trigger.id,
                messageId: trigger.message_id,
                sourceTaskId: triggerMessage.source_task_id,
                recipientTaskId: trigger.recipient_task_id,
                status: "failed",
                deliveredAt: null,
                failureReason: "target_removed",
              },
              message: triggerMessage,
              openAccountSourceTaskId: undefined,
            })
          : { kind: "none" as const };
      if (outcome.kind === "none") {
        throw new Error("host target_removed notice classification failed");
      }
      const pending = this.db
        .prepare(
          `SELECT delivery_id FROM host_dispatches
           WHERE edge_id = ? AND state = 'pending'
           ORDER BY created_at, rowid`,
        )
        .all(dispatch.edge_id) as Array<{ delivery_id: string }>;
      const pendingIds = pending.map((row) => row.delivery_id);
      this.db
        .prepare(
          `UPDATE host_edges SET status = 'removed', ended_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(now, dispatch.edge_id);
      const endDispatch = this.db.prepare(
        `UPDATE host_dispatches
         SET state = 'terminal', ended_reason = ?, ended_at = ?
         WHERE delivery_id = ? AND state = 'pending'`,
      );
      const failDelivery = this.db.prepare(
        `UPDATE deliveries
         SET status = 'failed', failed_at = ?, failure_reason = ?,
             delivered_at = NULL
         WHERE id = ? AND status = 'queued'`,
      );
      const failedDeliveryIds: string[] = [];
      for (const pendingId of pendingIds) {
        const reason =
          pendingId === deliveryId ? "target_removed" : "target_removed_edge";
        if (endDispatch.run(reason, now, pendingId).changes !== 1) continue;
        if (failDelivery.run(now, reason, pendingId).changes === 1) {
          failedDeliveryIds.push(pendingId);
        }
      }
      this.db
        .prepare("DELETE FROM host_wake_hints WHERE edge_id = ?")
        .run(dispatch.edge_id);

      if (!this.store.getTask(dispatch.parent_task_id)) {
        return { failedDeliveryIds, noticeRecipientTaskId: null };
      }
      const messageId = randomUUID();
      const noticeDeliveryId = randomUUID();
      const message = outcome.notice.message;
      this.store.saveEvent(
        dispatch.parent_task_id,
        "task_outcome_notice",
        {
          messageId,
          reason: outcome.notice.reason,
          sourceTaskId: outcome.notice.sourceTaskId,
          targetTaskId: outcome.notice.targetTaskId,
          message,
        },
        { from_ref: "system" },
      );
      this.store.enqueueDeliveryRows({
        messageId,
        deliveryId: noticeDeliveryId,
        sourceTaskId: outcome.notice.targetTaskId,
        directTargetTaskId: dispatch.parent_task_id,
        sourceActor: "system",
        body: formatFieldBlock([
          {
            label: "target",
            value: `${dispatch.display_title} (${dispatch.remote_task_id})`,
          },
          { label: "message", value: message },
        ]),
        createdAt: now,
        projections: [{ taskId: dispatch.parent_task_id, role: "target" }],
      });
      return {
        failedDeliveryIds,
        noticeRecipientTaskId: dispatch.parent_task_id,
      };
    })();
    this.store.broadcastDeliveryStatus(result.failedDeliveryIds);
    return result;
  }

  getHostDispatch(deliveryId: string): HostDispatch | undefined {
    return this.db
      .prepare("SELECT * FROM host_dispatches WHERE delivery_id = ?")
      .get(deliveryId) as HostDispatch | undefined;
  }

  hasOpenHostDispatch(parentTaskId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM host_wake_hints h
           JOIN host_edges e ON e.id = h.edge_id
           WHERE e.parent_task_id = ? AND e.status = 'active'
           LIMIT 1`,
        )
        .get(parentTaskId) !== undefined
    );
  }

  isHostReportMessage(messageId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM host_report_receipts
           WHERE local_message_id = ? LIMIT 1`,
        )
        .get(messageId) !== undefined
    );
  }

  ingestHostReport(input: HostReportReceiptInput): {
    status: "queued" | "duplicate" | "parent_deleted" | "unmatched";
    localMessageId?: string;
  } {
    const localMessageId = randomUUID();
    const deliveryId = randomUUID();
    const now = Date.now();
    const result = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT 1 FROM host_report_receipts
           WHERE host_name = ? AND credential_hash = ? AND owner_message_id = ?`,
        )
        .get(input.hostName, input.credentialHash, input.ownerMessageId);
      if (existing) return { status: "duplicate" as const };
      const currentEdge = this.findHostEdge({
        hostName: input.hostName,
        credentialHash: input.credentialHash,
        remoteTaskId: input.ownerTaskId,
        parentTaskId: input.parentTaskId,
      });
      if (!currentEdge) return { status: "unmatched" as const };
      const parent = this.store.getTask(input.parentTaskId);
      if (!parent) {
        this.db
          .prepare(
            `INSERT INTO host_report_receipts
             (host_name, credential_hash, owner_message_id, local_message_id, edge_id,
              parent_task_id, result, received_at)
             VALUES (?, ?, ?, NULL, ?, ?, 'parent_deleted', ?)`,
          )
          .run(
            input.hostName,
            input.credentialHash,
            input.ownerMessageId,
            currentEdge.id,
            input.parentTaskId,
            now,
          );
        return { status: "parent_deleted" as const };
      }
      this.store.enqueueDeliveryRows({
        messageId: localMessageId,
        deliveryId,
        sourceTaskId: input.ownerTaskId,
        directTargetTaskId: input.parentTaskId,
        sourceActor: input.kind === "runtime_notice" ? "system" : "agent",
        body: input.body,
        createdAt: now,
        projections: [{ taskId: input.parentTaskId, role: "target" }],
      });
      this.db
        .prepare(
          `INSERT INTO host_report_receipts
           (host_name, credential_hash, owner_message_id, local_message_id, edge_id,
            parent_task_id, result, received_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          input.hostName,
          input.credentialHash,
          input.ownerMessageId,
          localMessageId,
          currentEdge.id,
          input.parentTaskId,
          now,
        );
      if (input.kind === "runtime_notice") {
        this.store.saveEvent(
          input.parentTaskId,
          "task_outcome_notice",
          {
            messageId: localMessageId,
            reason: input.reason ?? "unknown",
            sourceTaskId: input.ownerTaskId,
            targetTaskId: input.ownerTaskId,
            message: input.body,
            externalSourceHost: input.hostName,
            externalSourceTaskId: input.ownerTaskId,
          },
          { from_ref: "system" },
        );
      }
      if (input.kind !== "collaboration") {
        this.db
          .prepare("DELETE FROM host_wake_hints WHERE edge_id = ?")
          .run(currentEdge.id);
      }
      return { status: "queued" as const, localMessageId };
    })();
    if (result.status === "queued") {
      for (const observer of this.committedObservers) {
        observer(input.parentTaskId);
      }
    }
    return result;
  }

  activeHostEdges(): HostEdge[] {
    return this.db
      .prepare("SELECT * FROM host_edges WHERE status = 'active'")
      .all() as HostEdge[];
  }

  queuedHostReportRecipients(): string[] {
    if (!this.factsPresent) return [];
    return (
      this.db
        .prepare(
          `SELECT DISTINCT d.recipient_task_id
           FROM host_report_receipts r
           JOIN deliveries d ON d.message_id = r.local_message_id
           JOIN tasks t ON t.id = d.recipient_task_id
           WHERE d.status = 'queued' AND t.deleted_at IS NULL
           ORDER BY d.queued_at, d.rowid`,
        )
        .all() as Array<{ recipient_task_id: string }>
    ).map((row) => row.recipient_task_id);
  }
}
