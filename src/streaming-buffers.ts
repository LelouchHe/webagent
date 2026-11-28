import { randomUUID } from "node:crypto";

export interface StreamingSegment {
  segmentId: number;
  text: string;
}

export interface StreamingChunkCoords {
  epoch: string;
  segmentId: number;
  offset: number;
  endOffset: number;
}

export interface StreamingFlushedSegment {
  epoch: string;
  segmentId: number;
  text: string;
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

/**
 * Process-scoped in-flight streaming buffers with monotonic per-task segment
 * IDs and UTF-16 offsets. `epoch` is generated once per server process so
 * clients can deterministically distinguish segments across restarts, and
 * `lastSegmentId` stays monotonic across `/clear` so buffered pre-clear chunks
 * can never recreate a cleared preview bubble.
 */
export class StreamingBufferStore {
  readonly epoch: string;
  private readonly lastSegmentIds = new Map<string, number>();
  private readonly thinking = new Map<string, StreamingSegment>();
  private readonly assistant = new Map<string, StreamingSegment>();

  constructor(epoch = randomUUID()) {
    this.epoch = epoch;
  }

  appendThinking(taskId: string, text: string): StreamingChunkCoords {
    return this.append(this.thinking, taskId, text);
  }

  appendAssistant(taskId: string, text: string): StreamingChunkCoords {
    return this.append(this.assistant, taskId, text);
  }

  takeThinking(taskId: string): StreamingFlushedSegment | null {
    return this.take(this.thinking, taskId);
  }

  takeAssistant(taskId: string): StreamingFlushedSegment | null {
    return this.take(this.assistant, taskId);
  }

  /** Clear active buffers (e.g. on `/clear`) while preserving `lastSegmentId`. */
  clearTask(taskId: string): void {
    this.thinking.delete(taskId);
    this.assistant.delete(taskId);
  }

  /** Drop all state for a deleted task. */
  deleteTask(taskId: string): void {
    this.thinking.delete(taskId);
    this.assistant.delete(taskId);
    this.lastSegmentIds.delete(taskId);
  }

  /** Pure read of current streaming preview and watermark. Never flushes. */
  snapshot(taskId: string): StreamingSnapshot {
    const lastSegmentId = this.lastSegmentIds.get(taskId) ?? 0;
    const thinking = this.thinking.get(taskId);
    const assistant = this.assistant.get(taskId);
    const result: StreamingSnapshot = {
      epoch: this.epoch,
      lastSegmentId,
    };
    if (thinking && thinking.text.length > 0) {
      result.thinking = {
        segmentId: thinking.segmentId,
        endOffset: thinking.text.length,
        text: thinking.text,
      };
    }
    if (assistant && assistant.text.length > 0) {
      result.assistant = {
        segmentId: assistant.segmentId,
        endOffset: assistant.text.length,
        text: assistant.text,
      };
    }
    return result;
  }

  private append(
    map: Map<string, StreamingSegment>,
    taskId: string,
    text: string,
  ): StreamingChunkCoords {
    let seg = map.get(taskId);
    if (!seg) {
      const segmentId = (this.lastSegmentIds.get(taskId) ?? 0) + 1;
      this.lastSegmentIds.set(taskId, segmentId);
      seg = { segmentId, text: "" };
      map.set(taskId, seg);
    }
    const offset = seg.text.length;
    seg.text += text;
    return {
      epoch: this.epoch,
      segmentId: seg.segmentId,
      offset,
      endOffset: seg.text.length,
    };
  }

  private take(
    map: Map<string, StreamingSegment>,
    taskId: string,
  ): StreamingFlushedSegment | null {
    const seg = map.get(taskId);
    map.delete(taskId);
    if (!seg || seg.text.length === 0) return null;
    return {
      epoch: this.epoch,
      segmentId: seg.segmentId,
      text: seg.text,
    };
  }
}
