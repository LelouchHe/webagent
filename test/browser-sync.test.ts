import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { SseManager } from "../src/sse-manager.ts";
import { ClientRegistry } from "../src/client-registry.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import {
  projectStoredEvents,
  toEventFeedEntries,
} from "../src/event-egress.ts";
import { PreviewReconciler } from "../public/js/preview-reconciler.ts";
import {
  SyncHub,
  createDirectPortPair,
  type HubToTabMessage,
} from "../public/js/sync-hub.ts";
import { png } from "./image-bytes.ts";

describe("contract-08 browser sync mechanisms", () => {
  describe("server outer-commit event publication", () => {
    let dir: string;
    let store: Store;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "webagent-outer-commit-"));
      store = new Store(dir);
      store.createTask("t1", dir, "auto", "agent-a");
    });

    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("publishes only after outermost commit, drops rolled-back nested savepoints, and drops full outer rollbacks", () => {
      const published: number[] = [];
      store.onEventsCommitted((rows) => {
        for (const row of rows) published.push(row.seq);
      });

      // Outer tx with nested savepoint rollback: outer sibling survives, inner row dropped.
      const db = (store as unknown as { db: import("better-sqlite3").Database })
        .db;
      db.transaction(() => {
        store.saveEvent(
          "t1",
          "user_message",
          { text: "outer-1" },
          { from_ref: "user" },
        );
        assert.deepEqual(published, [], "must not publish before outer commit");
        try {
          db.transaction(() => {
            store.saveEvent(
              "t1",
              "user_message",
              { text: "inner-rolled-back" },
              { from_ref: "user" },
            );
            throw new Error("savepoint abort");
          })();
        } catch {
          // expected inner rollback
        }
        store.saveEvent(
          "t1",
          "user_message",
          { text: "outer-2" },
          { from_ref: "user" },
        );
        assert.deepEqual(published, [], "still inside outer tx");
      })();
      assert.deepEqual(published, [1, 2]);

      // Outer rollback drops everything.
      assert.throws(() => {
        db.transaction(() => {
          store.saveEvent(
            "t1",
            "user_message",
            { text: "doomed" },
            { from_ref: "user" },
          );
          throw new Error("outer abort");
        })();
      });
      assert.deepEqual(published, [1, 2]);

      // saveCompactSummary publishes exactly once.
      const compactRow = store.saveCompactSummary("t1", "compact summary");
      assert.deepEqual(published, [1, 2, compactRow.seq]);
    });

    it("emits thinking seal synchronously BEFORE same-stack message_chunk and invalidates label cache before agent_image egress", () => {
      const tasks = createTaskManager(store, dir, dir);
      store.createTask("t2", dir, "auto", "agent-a");
      const wireOrder: string[] = [];
      const sseManager = {
        broadcast(event: { type: string }) {
          wireOrder.push(`ephemeral:${event.type}`);
        },
      };
      store.onEventsCommitted((rows) => {
        const projected = projectStoredEvents(rows, { store, tasks });
        for (const entry of toEventFeedEntries(projected)) {
          wireOrder.push(`feed:${entry.data.type}`);
        }
      });

      const bridge = { resolvePermission: () => {} } as any;
      const lease = tasks.authority.leaseFor("t2");
      const cfg = {
        cancelTimeout: 1000,
        recentPathsLimit: 10,
        dataDir: dir,
        imageUploadLimit: 1024 * 1024,
      };

      // Warm an empty label cache before agent_image.
      assert.equal(tasks.getLabelMap("t2").size, 0);

      handleAgentEvent(
        Object.assign(
          { type: "thought_chunk", taskId: "t2", text: "hmm" },
          { executionLease: lease },
        ) as any,
        tasks,
        store,
        bridge,
        cfg,
        sseManager as any,
      );
      handleAgentEvent(
        Object.assign(
          { type: "message_chunk", taskId: "t2", text: "ans" },
          { executionLease: lease },
        ) as any,
        tasks,
        store,
        bridge,
        cfg,
        sseManager as any,
      );
      // Causal order: thinking seal (feed:thinking) MUST precede same-stack ephemeral:message_chunk!
      assert.deepEqual(wireOrder, [
        "ephemeral:thought_chunk",
        "feed:thinking",
        "ephemeral:message_chunk",
      ]);

      handleAgentEvent(
        Object.assign(
          {
            type: "agent_image",
            taskId: "t2",
            block: { mimeType: "image/png", data: png(128).toString("base64") },
          },
          { executionLease: lease },
        ) as any,
        tasks,
        store,
        bridge,
        cfg,
        sseManager as any,
      );
      assert.ok(tasks.getLabelMap("t2").size > 0);
      tasks.dispose();
    });
  });

  describe("/visibility post-readBody liveness and X-Visibility-Rev", () => {
    it("returns 404 without recreating ClientRegistry entry when client disconnects during body read", async () => {
      const dir = mkdtempSync(join(tmpdir(), "webagent-vis-liveness-"));
      const publicDir = join(dir, "public");
      mkdirSync(publicDir);
      writeFileSync(join(publicDir, "index.html"), "");
      const store = new Store(dir);
      const sseManager = new SseManager(60_000);
      const registry = new ClientRegistry();
      const clientId = "cl-race";
      sseManager.add({
        id: clientId,
        res: { writableEnded: false, write: () => true, on: () => {} } as any,
      });

      const handler = createRequestHandler({
        store,
        sseManager,
        clientRegistry: registry,
        publicDir,
        dataDir: dir,
        limits: { bash_output: 1024, image_upload: 1024 },
        onRequestBodyReadStart: () => {
          // Simulate SSE disconnect while body is streaming in.
          sseManager.remove(clientId, "closed");
          registry.remove(clientId);
        },
      });
      const server = http.createServer(handler);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;

      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/beta/clients/${clientId}/visibility`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Visibility-Rev": "1",
            },
            body: JSON.stringify({ taskIds: ["t1"] }),
          },
        );
        assert.equal(res.status, 404);
        assert.equal(registry.get(clientId), undefined);
      } finally {
        await new Promise<void>((r) => {
          server.close(() => {
            r();
          });
        });
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("PreviewReconciler", () => {
    it("reconciles overlapping chunks (B + AB + C), flush during snapshot, stale seal, restart epoch, and /clear watermark", () => {
      const r = new PreviewReconciler();

      // Snapshot has "AB" (segment 1, endOffset 2)
      const s1 = r.applySnapshot({
        epoch: "ep-1",
        lastSegmentId: 1,
        assistant: { segmentId: 1, endOffset: 2, text: "AB" },
      });
      assert.deepEqual(s1.assistant, { mode: "replace", text: "AB" });

      // Overlapping chunk "B" (offset 1, endOffset 2) -> ignored
      assert.deepEqual(
        r.applyChunk("assistant", {
          epoch: "ep-1",
          segmentId: 1,
          offset: 1,
          endOffset: 2,
          text: "B",
        }),
        { action: "ignore" },
      );

      // Overlapping chunk "BC" (offset 1, endOffset 3) -> appends only "C"
      assert.deepEqual(
        r.applyChunk("assistant", {
          epoch: "ep-1",
          segmentId: 1,
          offset: 1,
          endOffset: 3,
          text: "BC",
        }),
        { action: "append", text: "C" },
      );

      // Prefix gap (offset 5 > renderedEndOffset 3) -> triggers resync
      assert.deepEqual(
        r.applyChunk("assistant", {
          epoch: "ep-1",
          segmentId: 1,
          offset: 5,
          endOffset: 6,
          text: "F",
        }),
        { action: "resync" },
      );

      // Persisted seal for segment 1 seals active; late snapshot with segment 1 is rejected
      assert.deepEqual(
        r.applyPersistedSeal("assistant", { epoch: "ep-1", segmentId: 1 }),
        { sealsActive: true },
      );
      const lateSnap = r.applySnapshot({
        epoch: "ep-1",
        lastSegmentId: 1,
        assistant: { segmentId: 1, endOffset: 3, text: "ABC" },
      });
      assert.equal(lateSnap.assistant, undefined);

      // /clear watermark: snapshot has lastSegmentId=3 and no active buffers.
      // Buffered old 0-offset chunk for segment 2 MUST be ignored; segment 4 accepted!
      r.applySnapshot({ epoch: "ep-1", lastSegmentId: 3 });
      assert.deepEqual(
        r.applyChunk("assistant", {
          epoch: "ep-1",
          segmentId: 2,
          offset: 0,
          endOffset: 3,
          text: "old",
        }),
        { action: "ignore" },
      );
      assert.deepEqual(
        r.applyChunk("assistant", {
          epoch: "ep-1",
          segmentId: 4,
          offset: 0,
          endOffset: 3,
          text: "new",
        }),
        { action: "start", text: "new" },
      );

      // Server restart (ep-2 reuses segmentId 1): catch-up seal from ep-1 must NOT pollute ep-2!
      r.applySnapshot({
        epoch: "ep-2",
        lastSegmentId: 1,
        assistant: { segmentId: 1, endOffset: 2, text: "hi" },
      });
      assert.deepEqual(
        r.applyPersistedSeal("assistant", { epoch: "ep-1", segmentId: 1 }),
        { sealsActive: false },
      );
      assert.deepEqual(
        r.applyChunk("assistant", {
          epoch: "ep-2",
          segmentId: 1,
          offset: 2,
          endOffset: 3,
          text: "!",
        }),
        { action: "append", text: "!" },
      );
    });
  });

  describe("SyncHub multi-tab coordination", () => {
    it("shares one SSE across two tabs, broadcasts topology + pendingCount, aggregates visibility, and enforces 5s grace", async () => {
      let now = 1_000;
      const timers = new Map<
        number,
        { at: number; cb: () => void; interval?: number }
      >();
      let nextId = 1;
      const clock = {
        now: () => now,
        setTimeout: (cb: () => void, ms: number) => {
          const id = nextId++;
          timers.set(id, { at: now + ms, cb });
          return id;
        },
        clearTimeout: (h: unknown) => {
          timers.delete(h as number);
        },
        setInterval: (cb: () => void, ms: number) => {
          const id = nextId++;
          timers.set(id, { at: now + ms, cb, interval: ms });
          return id;
        },
        clearInterval: (h: unknown) => {
          timers.delete(h as number);
        },
      };
      const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
          const next = [...timers].sort(([, a], [, b]) => a.at - b.at).at(0);
          if (!next || next[1].at > end) break;
          now = next[1].at;
          if (next[1].interval === undefined) timers.delete(next[0]);
          else next[1].at += next[1].interval;
          next[1].cb();
        }
        now = end;
      };

      const visPosts: Array<{ rev: string | null; taskIds: string[] }> = [];
      let esCount = 0;
      let closedCount = 0;
      let activeEs: { onmessage: ((e: MessageEvent) => void) | null } | null =
        null;

      class FakeES {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          esCount += 1;
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          activeEs = this;
        }
        addEventListener() {}
        close() {
          closedCount += 1;
        }
      }

      const hub = new SyncHub({
        clock,
        EventSourceImpl: FakeES as unknown as typeof EventSource,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          if (url === "/api/v1/sse-ticket") {
            return {
              ok: true,
              status: 200,
              json: async () => ({ ticket: "tk-1" }),
            } as Response;
          }
          if (url.includes("/visibility")) {
            const headers = init?.headers as Record<string, string>;
            const body = JSON.parse(init?.body as string) as {
              taskIds: string[];
            };
            visPosts.push({
              rev: headers["X-Visibility-Rev"] ?? null,
              taskIds: body.taskIds,
            });
            return {
              ok: true,
              status: 200,
              json: async () => ({ ok: true }),
            } as Response;
          }
          return { ok: true, status: 200, json: async () => ({}) } as Response;
        }) as typeof fetch,
      });

      const tabA = createDirectPortPair();
      const tabB = createDirectPortPair();
      const msgsA: HubToTabMessage[] = [];
      const msgsB: HubToTabMessage[] = [];
      tabA.tabPort.onMessage((m) => msgsA.push(m));
      tabB.tabPort.onMessage((m) => msgsB.push(m));

      hub.attach(tabA.hubPort);
      tabA.tabPort.postMessage({
        type: "hello",
        token: "t1",
        visible: true,
        taskId: "task-A",
      });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(esCount, 1);

      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "connected",
          clientId: "cl-1",
          pendingCount: 2,
        }),
      } as MessageEvent);
      // Update pendingCount via inbox_count_changed before Tab B joins.
      activeEs!.onmessage?.({
        data: JSON.stringify({ type: "inbox_count_changed", pendingCount: 5 }),
      } as MessageEvent);

      hub.attach(tabB.hubPort);
      tabB.tabPort.postMessage({
        type: "hello",
        token: "t1",
        visible: true,
        taskId: "task-B",
      });
      assert.equal(esCount, 1, "second tab must reuse single SSE");
      const bConnected = msgsB.find((m) => m.type === "connected");
      assert.equal(
        bConnected?.type === "connected" && bConnected.pendingCount,
        5,
      );
      assert.deepEqual(visPosts.at(-1)?.taskIds, ["task-A", "task-B"]);

      // Topology broadcast reaches Tab A even when event is for task-C.
      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "task_title_updated",
          taskId: "task-C",
          title: "New",
        }),
      } as MessageEvent);
      assert.ok(
        msgsA.some(
          (m) => m.type === "control" && m.event.type === "task_title_updated",
        ),
      );

      // Last tab bye immediately posts { taskIds: [] } and waits 5s grace before closing SSE.
      tabA.tabPort.postMessage({ type: "bye" });
      tabB.tabPort.postMessage({ type: "bye" });
      assert.deepEqual(visPosts.at(-1)?.taskIds, []);
      assert.equal(closedCount, 0, "SSE stays open during 5s grace");
      advance(5_000);
      assert.equal(closedCount, 1, "SSE closes after 5s grace");
    });
  });
});
