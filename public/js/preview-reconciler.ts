// Deterministic in-flight streaming preview reconciliation keyed by
// server process `epoch`, monotonic per-task `segmentId`, and UTF-16 offsets.

import type {
  AgentCommandSnapshot,
  ContextUsage,
  PlanEntry,
} from "../../src/types.ts";

export interface RuntimeBusy {
  kind: "agent" | "bash";
  since: string;
  promptId: string | null;
  cancelStatus?: "requested" | "unconfirmed" | null;
}

export interface TaskSnapshot {
  version: number;
  seq: number;
  task: {
    id: string;
    title: string | null;
    cwd: string;
    cwdDisplay?: string;
    model: string | null;
    mode: string | null;
    createdAt: string | null;
    lastEventSeq: number;
  };
  runtime: {
    busy: RuntimeBusy | null;
    pendingPermissions?: unknown[];
    streaming?: { assistant: boolean; thinking: boolean };
    plan?: PlanEntry[] | null;
    contextUsage?: ContextUsage | null;
  };
  streaming?: StreamingSnapshot;
  imageReferences?: unknown;
  agentCommands?: AgentCommandSnapshot;
}

export interface StatePatchPayload {
  runtime?: {
    busy?: RuntimeBusy | null;
    plan?: PlanEntry[] | null;
    contextUsage?: ContextUsage | null;
  };
}

export interface StreamingSnapshotSegment {
  segmentId: number;
  endOffset: number;
  text: string;
}

export interface StreamingSnapshot {
  epoch: string;
  lastSegmentId: number;
  thinking?: StreamingSnapshotSegment;
  assistant?: StreamingSnapshotSegment;
}

export interface StreamingChunkInput {
  epoch?: string;
  segmentId?: number;
  offset?: number;
  endOffset?: number;
  text: string;
}

export type PreviewChunkAction =
  | { action: "ignore" }
  | { action: "start"; text: string }
  | { action: "append"; text: string }
  | { action: "resync" };

export interface PreviewSnapshotActions {
  thinking?: { mode: "replace" | "append"; text: string } | { mode: "clear" };
  assistant?: { mode: "replace" | "append"; text: string } | { mode: "clear" };
}

interface ActiveSlot {
  segmentId: number;
  renderedEndOffset: number;
}

export class PreviewReconciler {
  private epoch: string | null = null;
  private lastSegmentId = 0;
  private readonly sealedSegmentIds = new Set<number>();
  private activeThinking: ActiveSlot | null = null;
  private activeAssistant: ActiveSlot | null = null;

  reset(): void {
    this.epoch = null;
    this.lastSegmentId = 0;
    this.sealedSegmentIds.clear();
    this.activeThinking = null;
    this.activeAssistant = null;
  }

  /** Discard active unsealed previews (e.g. on disconnect) while keeping epoch/watermark until next snapshot. */
  clearActive(): void {
    this.activeThinking = null;
    this.activeAssistant = null;
  }

  getEpoch(): string | null {
    return this.epoch;
  }

  getLastSegmentId(): number {
    return this.lastSegmentId;
  }

  applySnapshot(streaming: StreamingSnapshot): PreviewSnapshotActions {
    const actions: PreviewSnapshotActions = {};
    if (this.epoch !== streaming.epoch) {
      this.epoch = streaming.epoch;
      this.lastSegmentId = 0;
      this.sealedSegmentIds.clear();
      if (this.activeThinking) {
        this.activeThinking = null;
        actions.thinking = { mode: "clear" };
      }
      if (this.activeAssistant) {
        this.activeAssistant = null;
        actions.assistant = { mode: "clear" };
      }
    }

    if (streaming.lastSegmentId > this.lastSegmentId) {
      this.lastSegmentId = streaming.lastSegmentId;
    }

    const thinkingAction = this.reconcileSlot("thinking", streaming.thinking);
    if (thinkingAction) actions.thinking = thinkingAction;

    const assistantAction = this.reconcileSlot(
      "assistant",
      streaming.assistant,
    );
    if (assistantAction) actions.assistant = assistantAction;

    return actions;
  }

  applyChunk(
    kind: "thinking" | "assistant",
    chunk: StreamingChunkInput,
  ): PreviewChunkAction {
    if (
      typeof chunk.epoch !== "string" ||
      typeof chunk.segmentId !== "number" ||
      typeof chunk.offset !== "number" ||
      typeof chunk.endOffset !== "number"
    ) {
      return { action: "append", text: chunk.text };
    }

    if (this.epoch === null || chunk.epoch !== this.epoch) {
      if (chunk.offset > 0) {
        return { action: "resync" };
      }
      this.epoch = chunk.epoch;
      this.lastSegmentId = 0;
      this.sealedSegmentIds.clear();
      this.activeThinking = null;
      this.activeAssistant = null;
    }

    if (this.sealedSegmentIds.has(chunk.segmentId)) {
      return { action: "ignore" };
    }

    const active =
      kind === "thinking" ? this.activeThinking : this.activeAssistant;

    if (active?.segmentId === chunk.segmentId) {
      if (chunk.endOffset <= active.renderedEndOffset) {
        return { action: "ignore" };
      }
      if (chunk.offset > active.renderedEndOffset) {
        return { action: "resync" };
      }
      const skip = active.renderedEndOffset - chunk.offset;
      const tail = skip > 0 ? chunk.text.slice(skip) : chunk.text;
      active.renderedEndOffset = chunk.endOffset;
      return tail.length > 0
        ? { action: "append", text: tail }
        : { action: "ignore" };
    }

    // Not the currently active segment: reject anything at or below the
    // snapshot watermark (e.g. buffered pre-/clear or already-flushed chunks).
    if (chunk.segmentId <= this.lastSegmentId) {
      return { action: "ignore" };
    }

    if (chunk.offset > 0) {
      return { action: "resync" };
    }

    const nextSlot: ActiveSlot = {
      segmentId: chunk.segmentId,
      renderedEndOffset: chunk.endOffset,
    };
    if (kind === "thinking") {
      this.activeThinking = nextSlot;
    } else {
      this.activeAssistant = nextSlot;
    }
    return { action: "start", text: chunk.text };
  }

  applyPersistedSeal(
    kind: "thinking" | "assistant",
    data: { epoch?: unknown; segmentId?: unknown },
  ): { sealsActive: boolean } {
    if (
      typeof data.epoch !== "string" ||
      typeof data.segmentId !== "number" ||
      this.epoch === null ||
      data.epoch !== this.epoch
    ) {
      return { sealsActive: false };
    }

    this.sealedSegmentIds.add(data.segmentId);
    if (data.segmentId > this.lastSegmentId) {
      this.lastSegmentId = data.segmentId;
    }

    if (
      kind === "thinking" &&
      this.activeThinking?.segmentId === data.segmentId
    ) {
      this.activeThinking = null;
      return { sealsActive: true };
    }
    if (
      kind === "assistant" &&
      this.activeAssistant?.segmentId === data.segmentId
    ) {
      this.activeAssistant = null;
      return { sealsActive: true };
    }
    return { sealsActive: false };
  }

  private reconcileSlot(
    kind: "thinking" | "assistant",
    seg: StreamingSnapshotSegment | undefined,
  ): PreviewSnapshotActions["thinking"] {
    const active =
      kind === "thinking" ? this.activeThinking : this.activeAssistant;
    if (!seg || this.sealedSegmentIds.has(seg.segmentId)) {
      if (active) {
        if (kind === "thinking") this.activeThinking = null;
        else this.activeAssistant = null;
        return { mode: "clear" };
      }
      return undefined;
    }

    if (active?.segmentId === seg.segmentId) {
      if (seg.endOffset > active.renderedEndOffset) {
        const tail = seg.text.slice(active.renderedEndOffset);
        active.renderedEndOffset = seg.endOffset;
        return tail.length > 0 ? { mode: "append", text: tail } : undefined;
      }
      return undefined;
    }

    const nextSlot: ActiveSlot = {
      segmentId: seg.segmentId,
      renderedEndOffset: seg.endOffset,
    };
    if (kind === "thinking") this.activeThinking = nextSlot;
    else this.activeAssistant = nextSlot;
    return { mode: "replace", text: seg.text };
  }
}
