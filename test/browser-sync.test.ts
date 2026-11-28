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

      // Topology broadcast reaches Tab A ONCE via control (never duplicated to ephemeral on focused tab).
      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "task_title_updated",
          taskId: "task-A",
          title: "New",
        }),
      } as MessageEvent);
      assert.equal(
        msgsA.filter(
          (m) => m.type === "control" && m.event.type === "task_title_updated",
        ).length,
        1,
      );
      assert.equal(
        msgsA.filter(
          (m) =>
            m.type === "ephemeral" && m.event.type === "task_title_updated",
        ).length,
        0,
      );

      // Last tab bye immediately posts { taskIds: [] } and waits 5s grace before closing SSE.
      tabA.tabPort.postMessage({ type: "bye" });
      tabB.tabPort.postMessage({ type: "bye" });
      assert.deepEqual(visPosts.at(-1)?.taskIds, []);
      assert.equal(closedCount, 0, "SSE stays open during 5s grace");

      // F4: BFCache pageshow re-admits a previously detached port on hello and delivers future frames + visibility.
      tabA.tabPort.postMessage({
        type: "hello",
        token: "t1",
        visible: true,
        taskId: "task-A",
      });
      assert.deepEqual(visPosts.at(-1)?.taskIds, ["task-A"]);
      const feedBefore = msgsA.filter((m) => m.type === "feed_entry").length;
      activeEs!.onmessage?.({
        data: JSON.stringify({
          feed: "task-A",
          pos: 1,
          prev: 0,
          data: {
            id: 1,
            task_id: "task-A",
            seq: 1,
            type: "user_message",
            data: '{"text":"after bfcache"}',
            from_ref: "user",
            created_at: new Date().toISOString(),
          },
        }),
      } as MessageEvent);
      assert.equal(
        msgsA.filter((m) => m.type === "feed_entry").length,
        feedBefore + 1,
      );

      // Detach again and verify 5s grace closes SSE.
      tabA.tabPort.postMessage({ type: "bye" });
      assert.equal(closedCount, 0);
      advance(5_000);
      assert.equal(closedCount, 1, "SSE closes after 5s grace");
    });

    it("invalidates stale ports on credential rotation, fences delayed auth_update, and never echoes raw token on 401 (F5)", async () => {
      let ticketStatus = 200;
      const seenAuthHeaders: string[] = [];
      let activeEs: { onmessage: ((e: MessageEvent) => void) | null } | null =
        null;

      class FakeES {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          activeEs = this;
        }
        addEventListener() {}
        close() {}
      }

      const hub = new SyncHub({
        EventSourceImpl: FakeES as unknown as typeof EventSource,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          if (url === "/api/v1/sse-ticket") {
            seenAuthHeaders.push(headers.Authorization || "");
            return {
              ok: ticketStatus === 200,
              status: ticketStatus,
              json: async () =>
                ticketStatus === 200
                  ? { ticket: "tk" }
                  : { error: "Unauthorized" },
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
          } as Response;
        }) as typeof fetch,
      });

      const tabOld = createDirectPortPair();
      const tabNew = createDirectPortPair();
      const tabUnadmitted = createDirectPortPair();
      const msgsOld: HubToTabMessage[] = [];
      const msgsNew: HubToTabMessage[] = [];
      const msgsUnadmitted: HubToTabMessage[] = [];
      tabOld.tabPort.onMessage((m) => msgsOld.push(m));
      tabNew.tabPort.onMessage((m) => msgsNew.push(m));
      tabUnadmitted.tabPort.onMessage((m) => msgsUnadmitted.push(m));

      // Attach ready-only unadmitted port.
      hub.attach(tabUnadmitted.hubPort);

      // Tab Old logs in with tok-1.
      hub.attach(tabOld.hubPort);
      tabOld.tabPort.postMessage({
        type: "hello",
        token: "tok-1",
        visible: true,
        taskId: "t1",
        expectedAuthGen: 0,
      });
      await new Promise((r) => setTimeout(r, 0));
      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "connected",
          clientId: "c1",
          pendingCount: 0,
        }),
      } as MessageEvent);

      // Tab New rotates to tok-2 -> Tab Old MUST lose admission until it confirms authGen=2.
      hub.attach(tabNew.hubPort);
      tabNew.tabPort.postMessage({
        type: "hello",
        token: "tok-2",
        visible: true,
        taskId: "t1",
        expectedAuthGen: 1,
      });
      await new Promise((r) => setTimeout(r, 0));
      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "connected",
          clientId: "c2",
          pendingCount: 0,
        }),
      } as MessageEvent);
      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "inbox_count_changed",
          pendingCount: 9,
        }),
      } as MessageEvent);
      assert.equal(
        msgsOld.some(
          (m) => m.type === "control" && m.event.type === "inbox_count_changed",
        ),
        false,
        "unconfirmed old port must not receive new-token stream",
      );
      assert.equal(
        msgsNew.some(
          (m) => m.type === "control" && m.event.type === "inbox_count_changed",
        ),
        true,
      );

      // Delayed stale auth_update from Tab Old with expectedAuthGen=1 must NOT rotate hub backward.
      const beforeHeaders = seenAuthHeaders.length;
      tabOld.tabPort.postMessage({
        type: "auth_update",
        token: "tok-1",
        expectedAuthGen: 1,
      });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seenAuthHeaders.length, beforeHeaders);

      // 401 on tok-3: notifies ONLY admitted tabNew with its non-secret admissionId (never raw token).
      ticketStatus = 401;
      tabNew.tabPort.postMessage({
        type: "auth_update",
        token: "tok-3",
        expectedAuthGen: 2,
        admissionId: "adm-opaque-uuid-3",
      });
      await new Promise((r) => setTimeout(r, 0));
      const invNew = msgsNew.find((m) => m.type === "auth_invalid");
      assert.ok(invNew, "admitted port receives auth_invalid");
      assert.equal(invNew.admissionId, "adm-opaque-uuid-3");
      assert.equal(
        JSON.stringify(invNew).includes("tok-3"),
        false,
        "auth_invalid must never echo raw token",
      );
      assert.ok(
        msgsOld.some((m) => m.type === "disconnected"),
        "prior-generation port is disconnected on token rotation",
      );
      assert.ok(
        msgsNew.some((m) => m.type === "disconnected"),
        "initiating port is ALSO disconnected on token rotation so its old consumer aborts",
      );
      assert.equal(
        msgsUnadmitted.some((m) => m.type === "auth_invalid"),
        false,
        "unadmitted ready-only port must not receive auth_invalid",
      );
      assert.equal(
        msgsOld.some((m) => m.type === "auth_invalid"),
        false,
        "stale unconfirmed port must not receive auth_invalid for newer gen",
      );
    });

    it("separates routeTaskId from visibleTaskId during pending navigation (R3-3, R4-1)", async () => {
      let activeEs: {
        onmessage?: ((ev: MessageEvent) => void) | null;
        close: () => void;
      } | null = null;
      const visPosts: string[][] = [];
      class FakeES {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          activeEs = this;
        }
        addEventListener() {}
        close() {}
      }
      const hub = new SyncHub({
        EventSourceImpl: FakeES as unknown as typeof EventSource,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          if (url.includes("/sse-ticket")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ ticket: "tk" }),
            } as Response;
          }
          if (url.includes("/visibility") && init?.method === "POST") {
            const body = JSON.parse(
              typeof init.body === "string" ? init.body : "{}",
            ) as { taskIds?: string[] };
            visPosts.push(body.taskIds ?? []);
          }
          return { ok: true, status: 204, json: async () => ({}) } as Response;
        }) as typeof fetch,
      });
      const tab = createDirectPortPair();
      const msgs: HubToTabMessage[] = [];
      tab.tabPort.onMessage((m) => msgs.push(m));
      hub.attach(tab.hubPort);
      tab.tabPort.postMessage({
        type: "hello",
        token: "tok",
        visible: true,
        taskId: null,
        admissionId: "adm-vis-1",
      });
      await new Promise((r) => setTimeout(r, 0));
      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "connected",
          clientId: "c-vis-1",
          pendingCount: 0,
        }),
      } as MessageEvent);
      // Tab announces navigation focus to task-nav while state.taskId is still null.
      tab.tabPort.postMessage({
        type: "focus",
        taskId: "task-nav",
        gen: 1,
        visible: true,
      });
      // Visibility renewal sends taskId: null (pre-activation state.taskId) —
      // clears visibleTaskId (push suppression = []) without clearing routeTaskId.
      tab.tabPort.postMessage({
        type: "visibility",
        visible: true,
        taskId: null,
      });
      assert.deepEqual(
        visPosts.at(-1),
        [],
        "visibility stays [] until task-nav is actually displayed",
      );
      activeEs!.onmessage?.({
        data: JSON.stringify({
          type: "task_runtime_warmed",
          taskId: "task-nav",
          agentId: "a1",
          configOptions: [
            { id: "model", name: "Model", currentValue: "m1", options: [] },
          ],
          agentCommands: { epoch: "e1", revision: 1, commands: [] },
        }),
      } as MessageEvent);
      assert.ok(
        msgs.some(
          (m) =>
            m.type === "ephemeral" &&
            m.event.type === "task_runtime_warmed" &&
            m.event.taskId === "task-nav",
        ),
        "visibility update must not overwrite focus routeTaskId routing",
      );
      // Once task-nav is displayed, visibility reports taskId: "task-nav" -> push suppression activates.
      tab.tabPort.postMessage({
        type: "visibility",
        visible: true,
        taskId: "task-nav",
      });
      assert.deepEqual(visPosts.at(-1), ["task-nav"]);
    });
  });

  describe("per-task SSE edge and empty 201/200 body classification (F11, F12)", () => {
    it("omits duplicate bash_result on per-task SSE clients while keeping it on global feed", () => {
      const sse = new SseManager(60_000);
      const globalFrames: string[] = [];
      const perTaskFrames: string[] = [];
      sse.add({
        id: "g1",
        res: {
          writableEnded: false,
          write: (s: string) => {
            globalFrames.push(s);
            return true;
          },
          on: () => {},
        } as any,
      });
      sse.add({
        id: "t1-client",
        taskId: "t1",
        res: {
          writableEnded: false,
          write: (s: string) => {
            perTaskFrames.push(s);
            return true;
          },
          on: () => {},
        } as any,
      });
      sse.broadcastFeedEntry({
        feed: "t1",
        pos: 5,
        prev: 4,
        data: {
          id: 5,
          task_id: "t1",
          seq: 5,
          type: "bash_result",
          data: JSON.stringify({ output: "ok", code: 0, signal: null }),
          from_ref: "system",
          created_at: new Date().toISOString(),
        },
      });
      assert.equal(globalFrames.length, 1);
      assert.equal(perTaskFrames.length, 0);
    });

    it("treats empty 201/200 JSON responses as unknown while allowing 204", async () => {
      const { sendApiRaw } = await import("../public/js/api-transport.ts");
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 201,
          text: async () => "",
        })) as unknown as typeof fetch;
        const empty201 = await sendApiRaw("/api/v1/tasks", {
          method: "POST",
          body: {},
          opId: null,
        });
        assert.equal(empty201.kind, "unknown");

        globalThis.fetch = (async () => ({
          ok: true,
          status: 204,
          text: async () => "",
        })) as unknown as typeof fetch;
        const ok204 = await sendApiRaw("/api/v1/tasks/t1", {
          method: "DELETE",
          opId: null,
        });
        assert.equal(ok204.kind, "success");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
