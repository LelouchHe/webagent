import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import type { AgentEvent, ToolContentItem } from "../src/types.ts";

/**
 * Shared harness for the two tool-result image suites.
 *
 * Everything runs through the real event handler, so an assertion about
 * persisted content also covers what is broadcast: what reaches the store is
 * what a client sees.
 */

export const LIMIT = 1024 * 1024;

/** Bytes with a PNG signature: enough for the container sniff. */
export function png(payloadBytes = 64): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return Buffer.concat([
    signature,
    Buffer.alloc(Math.max(0, payloadBytes - signature.length), 7),
  ]);
}

/** A real 1x1 PNG, for a file a tool result may point at. */
export const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=",
  "base64",
);

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ToolResultImageHarness {
  dir: string;
  store: Store;
  tasks: TaskManager;
  broadcasts: AgentEvent[];
  emit(event: AgentEvent): void;
  toolCall(id: string, title: string): void;
  update(id: string, content: ToolContentItem[], status?: string): AgentEvent;
  /** The content array of the task's single stored `tool_call_update`. */
  storedContent(): ToolContentItem[];
}

export interface ToolResultImageHarnessOptions {
  /**
   * The real SSE manager to broadcast through. The default only records
   * events; a test that asserts on the wire frame passes the real manager with
   * a fake response.
   */
  sseManager?: Parameters<typeof handleAgentEvent>[5];
  /**
   * Wrap the harness store, e.g. to make one attachments-table call fail.
   */
  decorateStore?: (store: Store) => Store;
}

export function createToolResultImageHarness(
  options: ToolResultImageHarnessOptions = {},
): ToolResultImageHarness {
  const dir = mkdtempSync(join(tmpdir(), "webagent-tool-result-images-"));
  const realStore = new Store(join(dir, "db"));
  const store = options.decorateStore
    ? options.decorateStore(realStore)
    : realStore;
  const tasks = createTaskManager(store, dir, dir);
  store.createTask("t1", "/tmp", "auto", "test-agent");
  const broadcasts: AgentEvent[] = [];

  const bridge = {
    resolvePermission: () => {},
  } as unknown as Parameters<typeof handleAgentEvent>[3];
  const sseManager =
    options.sseManager ??
    ({
      broadcast: (event: AgentEvent) => {
        broadcasts.push(event);
      },
    } as unknown as Parameters<typeof handleAgentEvent>[5]);

  function config() {
    return {
      cancelTimeout: 10000,
      recentPathsLimit: 10,
      dataDir: dir,
      imageUploadLimit: LIMIT,
    };
  }

  function withLease<T extends object>(event: T): T {
    const taskId = (event as { taskId?: unknown }).taskId;
    if (typeof taskId !== "string") return event;
    const lease = tasks.authority.leaseFor(taskId);
    return lease ? Object.assign({}, event, { executionLease: lease }) : event;
  }

  function emit(event: AgentEvent): void {
    handleAgentEvent(
      withLease(event),
      tasks,
      store,
      bridge,
      config(),
      sseManager,
    );
  }

  function toolCall(id: string, title: string): void {
    emit({ type: "tool_call", taskId: "t1", id, title, kind: "other" });
  }

  function update(
    id: string,
    content: ToolContentItem[],
    status = "completed",
  ): AgentEvent {
    return { type: "tool_call_update", taskId: "t1", id, status, content };
  }

  function storedContent(): ToolContentItem[] {
    const row = store
      .getEvents("t1")
      .find((event) => event.type === "tool_call_update");
    if (!row) throw new Error("no stored tool_call_update");
    return (JSON.parse(row.data) as { content: ToolContentItem[] }).content;
  }

  return {
    dir,
    store,
    tasks,
    broadcasts,
    emit,
    toolCall,
    update,
    storedContent,
  };
}

export function disposeToolResultImageHarness(
  harness: ToolResultImageHarness,
): void {
  harness.tasks.dispose();
  harness.store.close();
  rmSync(harness.dir, { recursive: true, force: true });
}

/** Text carried by `content` items, one line per item, empties dropped. */
export function textOf(content: ToolContentItem[]): string {
  return content
    .map((item) => {
      const inner = item.content;
      return inner && !Array.isArray(inner) && typeof inner.text === "string"
        ? inner.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** The stored descriptor on one content item, or null. */
export function attachmentOf(
  item: ToolContentItem,
): Record<string, unknown> | null {
  const attachment = (item as unknown as { attachment?: unknown }).attachment;
  return attachment && typeof attachment === "object"
    ? (attachment as Record<string, unknown>)
    : null;
}
