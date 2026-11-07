import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import type Database from "better-sqlite3";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { TaskManager as TaskManagerClass } from "../src/task-manager.ts";
import { turnOriginForDeliveryBatch } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import type { AgentEnvironment } from "../src/agent-registry.ts";
import { StaticAgentEnvironment } from "../src/agent-registry.ts";
import type { ExecutionAdapter } from "../src/execution-adapter.ts";
import type { AgentBridge } from "../src/bridge.ts";
import { createRequestHandler } from "../src/routes.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import { SseManager } from "../src/sse-manager.ts";
import type { AgentEvent } from "../src/types.ts";
import type { DirectedObligation } from "../src/obligation-controller.ts";
import {
  makeEventHandlerConfig,
  mockBridgeStubs,
  type MockBridge,
  waitFor,
} from "./fixtures.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: data });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** The response fields the routes under test return. */
interface TestResponseBody {
  error?: string;
  busyKind?: string;
  reset?: boolean;
  status?: string;
  taskId?: string;
}

/** Parse a test response body into that shape instead of leaking `any`. */
function bodyOf(res: { body: string }): TestResponseBody {
  return JSON.parse(res.body) as TestResponseBody;
}

/** A prompt that stays pending until the test settles it. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The one transport this harness drives.
 *
 * `MockBridge` is already the `AgentBridge` subset the routes and the runtime
 * call, and it structurally satisfies `DeliveryBridge`; the only member it
 * lacks is `promptForText`, which lives on the full class. Declaring the double
 * as this union is what lets every drain, route, and prompt-owner call take it
 * without a cast — and lets a test replace one method without punching a hole
 * in the type. A fresh double per test also keeps one test's overrides from
 * leaking into the next.
 */
type TestBridge = MockBridge & Pick<AgentBridge, "promptForText">;

/**
 * The runtime's agent environments, with a controllable cold start.
 *
 * `resolve()` is the await inside `resolveDeliveryTransport`: with no transport
 * bound yet it is where a target's agent process starts. Holding it open is how
 * a test reproduces a submitter arriving inside that window. Everything else is
 * the ordinary static environment.
 */
class GatedEnvironment implements AgentEnvironment {
  readonly defaultAgentId: string;
  private readonly inner: StaticAgentEnvironment;
  /** How many of the next `resolve()` calls wait on `gate` first. */
  holdCalls = 0;
  gate: Promise<void> = Promise.resolve();
  /** `resolve()` calls that reached the gate, for deterministic ordering. */
  resolveCalls = 0;

  constructor(defaultAgentId: string) {
    this.defaultAgentId = defaultAgentId;
    this.inner = new StaticAgentEnvironment(defaultAgentId);
  }

  isConfigured(agentId: string): boolean {
    return this.inner.isConfigured(agentId);
  }

  existing(agentId: string): ExecutionAdapter | undefined {
    return this.inner.existing(agentId);
  }

  listExisting(): ExecutionAdapter[] {
    return this.inner.listExisting();
  }

  adapterFor(agentId: string): ExecutionAdapter {
    return this.inner.adapterFor(agentId);
  }

  async resolve(agentId: string): Promise<ExecutionAdapter> {
    this.resolveCalls += 1;
    if (this.holdCalls > 0) {
      this.holdCalls -= 1;
      const gate = this.gate;
      this.gate = Promise.resolve();
      await gate;
    }
    return this.inner.resolve(agentId);
  }

  async reload(
    agentId: string,
    run: (adapter: ExecutionAdapter) => Promise<void>,
  ): Promise<void> {
    return this.inner.reload(agentId, run);
  }
}

describe("turn slot", () => {
  let store: Store;
  let tasks: TaskManager;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let environment: GatedEnvironment;
  /** Prompts a route or runtime submission opened, settled by the test. */
  let openPrompts: Array<ReturnType<typeof deferred>>;
  /**
   * Every `bridge.prompt` the runtime really made, in order. This record — not
   * the slot — is the source of truth for a turn's identity in these tests.
   */
  let promptCalls: Array<{ taskId: string; text: string; promptId?: string }>;
  let bridge: TestBridge;
  /** The real broadcaster: with no connected clients every send is a no-op. */
  let sseManager: SseManager;

  function createTask(id: string, parentId?: string, agentId = "test-agent") {
    store.createTask(id, tmpDir, "auto", agentId, `${id}-session`, parentId);
    tasks.liveTasks.add(id);
    return id;
  }

  /** The identity the transport was actually handed for a task's last turn. */
  function lastPromptCall(taskId: string) {
    return promptCalls.filter((call) => call.taskId === taskId).at(-1);
  }

  function promptCallsFor(taskId: string) {
    return promptCalls.filter((call) => call.taskId === taskId);
  }

  /**
   * Settle the task's open turn the way the ACP transport does, naming the
   * prompt identity the transport actually received.
   */
  function finishPrompt(taskId: string): void {
    emit({
      type: "prompt_done",
      taskId,
      stopReason: "end_turn",
      promptId: lastPromptCall(taskId)?.promptId,
    });
  }

  /**
   * Drive one protocol event with the task's current generation lease.
   *
   * The lease rides on the event the same way the bridge stamps it
   * (`Object.assign`), so no cast is needed to add it.
   */
  function emit(event: AgentEvent & { taskId: string }): void {
    const lease = tasks.authority.leaseFor(event.taskId);
    handleAgentEvent(
      lease ? Object.assign({ ...event }, { executionLease: lease }) : event,
      tasks,
      store,
      // `handleAgentEvent` takes the concrete `AgentBridge` (connection,
      // process, emitters), which no test double can be; this one implements
      // every member the handler actually reaches for.
      bridge as unknown as AgentBridge,
      makeEventHandlerConfig(),
      sseManager,
    );
  }

  /** Drop the transport the way a process death does, keeping the task bound. */
  function unbindTransport(): void {
    environment.adapterFor("test-agent").bindBridge(null);
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-turn-slot-"));
    store = new Store(tmpDir);
    environment = new GatedEnvironment("test-agent");
    tasks = new TaskManagerClass({
      store,
      defaultCwd: tmpDir,
      dataDir: tmpDir,
      state: new TaskStateManager(),
      authority: new ExecutionAuthority(),
      agents: environment,
    });
    openPrompts = [];
    promptCalls = [];
    bridge = {
      ...mockBridgeStubs(),
      newSession: async () => ({
        sessionId: `agent-${Math.random().toString(16).slice(2)}`,
        configOptions: [],
      }),
      loadSession: async (taskId: string) => ({ taskId, configOptions: [] }),
      setConfigOption: async () => [],
      promptForText: async () => "summary of the current work",
      prompt: (taskId, text, _attachments, promptId) => {
        promptCalls.push({ taskId, text, promptId });
        return openPrompts.shift()?.promise ?? Promise.resolve();
      },
    };
    tasks.attachExecutionBridge(bridge);
    sseManager = new SseManager();
    store.attachAgentSession(
      store.ensureRootTask(tmpDir).id,
      "test-agent",
      "agent-root",
    );

    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");
    server = http.createServer(
      createRequestHandler({
        store,
        tasks,
        publicDir,
        dataDir: tmpDir,
        limits: {
          bash_output: 1_048_576,
          image_upload: 10_485_760,
          cancel_timeout: 10_000,
        },
        sseManager,
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("origin assignment", () => {
    it("classifies a delivery batch by its own messages", () => {
      assert.equal(
        turnOriginForDeliveryBatch(["agent", "system"]),
        "delegated",
      );
      assert.equal(
        turnOriginForDeliveryBatch(["agent", "user"]),
        "interactive",
      );
      assert.equal(turnOriginForDeliveryBatch(["user"]), "interactive");
      assert.equal(turnOriginForDeliveryBatch(["system"]), "delegated");
    });

    it("opens the interactive route's turn as interactive", async () => {
      const id = createTask("interactive");
      const pending = deferred();
      openPrompts.push(pending);

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${id}/prompt`,
        JSON.stringify({ text: "hi" }),
      );
      assert.equal(res.status, 202);
      assert.equal(tasks.getTurn(id)?.origin, "interactive");
      assert.equal(tasks.getTurn(id)?.kind, "agent");

      pending.resolve();
      await waitFor(() => tasks.getTurn(id) === null);
    });

    it("opens a runtime delivery's turn as delegated", async () => {
      createTask("source");
      createTask("target");
      store.createCollaborationMessage({
        id: "m1",
        deliveryId: "d1",
        sourceTaskId: "source",
        directTargetTaskId: "target",
        sourceActor: "agent",
        body: "dispatch",
        createdAt: 1,
      });
      const pending = deferred();
      openPrompts.push(pending);

      assert.equal(
        await tasks.drainCollaborationDeliveries("target", bridge),
        true,
      );
      assert.equal(tasks.getTurn("target")?.origin, "delegated");
      pending.resolve();
      await waitFor(
        () => store.getTask("target")?.workflow_status === "running",
      );
      finishPrompt("target");
      await waitFor(() => tasks.getTurn("target") === null);
    });

    it("opens a mixed or user delivery batch as interactive", async () => {
      createTask("source");
      createTask("target");
      for (const [index, actor] of (["agent", "user"] as const).entries()) {
        store.createCollaborationMessage({
          id: `m${index}`,
          deliveryId: `d${index}`,
          sourceTaskId: "source",
          directTargetTaskId: "target",
          sourceActor: actor,
          body: `message ${index}`,
          createdAt: index + 1,
        });
      }
      const pending = deferred();
      openPrompts.push(pending);

      assert.equal(
        await tasks.drainCollaborationDeliveries("target", bridge),
        true,
      );
      assert.equal(tasks.getTurn("target")?.origin, "interactive");
      pending.resolve();
      await waitFor(
        () => store.getTask("target")?.workflow_status === "running",
      );
      finishPrompt("target");
      await waitFor(() => tasks.getTurn("target") === null);
    });

    it("opens a closing reminder's turn as delegated", async () => {
      const obligation = seedReminder();
      const pending = deferred();
      openPrompts.push(pending);

      const submission = tasks.submitObligationReminder(obligation);
      await waitFor(() => tasks.getTurn("child") !== null, {
        message: "the reminder turn opened",
      });
      assert.equal(tasks.getTurn("child")?.origin, "delegated");

      pending.resolve();
      assert.deepEqual(await submission, { status: "delivered" });
      assert.equal(tasks.getTurn("child"), null);
    });

    it("opens /compact's turn as interactive", async () => {
      const id = createTask("compact");
      const pending = deferred();
      openPrompts.push(pending);
      let releaseSummary!: () => void;
      const summaryGate = new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      bridge.promptForText = async () => {
        await summaryGate;
        return "summary";
      };

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${id}/compact`,
        "{}",
      );
      assert.equal(res.status, 202);
      assert.equal(tasks.getTurn(id)?.origin, "interactive");

      releaseSummary();
      await waitFor(() => tasks.compactingTasks.size === 0);
      await waitFor(() => tasks.getTurn(id) === null);
    });

    it("opens a beta quick prompt's turn as interactive", async () => {
      const pending = deferred();
      openPrompts.push(pending);

      const res = await makeRequest(
        port,
        "POST",
        "/api/beta/prompt",
        JSON.stringify({ text: "quick question" }),
      );
      assert.equal(res.status, 202);
      const taskId = bodyOf(res).taskId;
      assert.ok(taskId, "the beta route answers with the task it created");
      assert.equal(tasks.getTurn(taskId)?.origin, "interactive");

      pending.resolve();
      await waitFor(() => tasks.getTurn(taskId) === null);
    });
  });

  describe("release points", () => {
    /**
     * The per-path release rows of the contract's end-of-turn table: run the
     * real release path for that row, then assert nothing about the turn
     * survives.
     *
     * The "task disappears" row — delete, cascade, GC/reap, Root subtree — is
     * deliberately absent here and covered by `describe("deletion entries")`
     * instead, through its production entries (the REST route and the
     * create-triggered sweep) with mutation checks. Cancel and restore are not
     * release points and are asserted separately.
     */
    const cases: Array<{
      name: string;
      /** Opens a turn for the path under test and returns its task id. */
      run: () => Promise<string>;
    }> = [
      {
        name: "prompt_done",
        run: async () => {
          const id = createTask("done");
          tasks.beginAgentTurn(id, { origin: "delegated" });
          emit({ type: "prompt_done", taskId: id, stopReason: "end_turn" });
          return id;
        },
      },
      {
        name: "agent error",
        run: async () => {
          const id = createTask("failed");
          tasks.beginAgentTurn(id, { origin: "delegated" });
          emit({ type: "error", taskId: id, message: "boom" });
          return id;
        },
      },
      {
        name: "drain dispatchFailed",
        run: async () => {
          createTask("source");
          const id = createTask("rejected");
          store.createCollaborationMessage({
            id: "m1",
            deliveryId: "d1",
            sourceTaskId: "source",
            directTargetTaskId: id,
            sourceActor: "agent",
            body: "dispatch",
            createdAt: 1,
          });
          const pending = deferred();
          openPrompts.push(pending);
          assert.equal(
            await tasks.drainCollaborationDeliveries(id, bridge),
            true,
          );
          pending.reject(new Error("prompt rejected"));
          await waitFor(() => tasks.getTurn(id) === null);
          return id;
        },
      },
      {
        name: "reminder finally",
        run: async () => {
          const obligation = seedReminder();
          bridge.loadSession = async () => {
            throw new Error("load failed");
          };
          assert.deepEqual(await tasks.submitObligationReminder(obligation), {
            status: "deferred",
            reason: "resume_failed",
          });
          // Restored for the follow-up turn the table runs after this row: it
          // needs a resume, and this row is the one that breaks it.
          bridge.loadSession = async (taskId: string) => ({
            taskId,
            configOptions: [],
          });
          return "child";
        },
      },
      {
        name: "interactive finally",
        run: async () => {
          const id = createTask("interactive-failed");
          const pending = deferred();
          openPrompts.push(pending);
          const res = await makeRequest(
            port,
            "POST",
            `/api/v1/tasks/${id}/prompt`,
            JSON.stringify({ text: "hi" }),
          );
          assert.equal(res.status, 202);
          pending.reject(new Error("prompt rejected"));
          await waitFor(() => tasks.getTurn(id) === null);
          return id;
        },
      },
      {
        name: "compact finally",
        run: async () => {
          const id = createTask("compact-failed");
          bridge.promptForText = async () => {
            throw new Error("summary failed");
          };
          const res = await makeRequest(
            port,
            "POST",
            `/api/v1/tasks/${id}/compact`,
            "{}",
          );
          assert.equal(res.status, 202);
          await waitFor(
            () =>
              tasks.compactingTasks.size === 0 && tasks.getTurn(id) === null,
          );
          return id;
        },
      },
      {
        name: "resetTaskRuntime (clear preserves state, not authorization)",
        run: async () => {
          const id = createTask("cleared");
          tasks.beginAgentTurn(id, { origin: "delegated" });
          // The compaction path is the one rotation that runs inside its own
          // turn; `preserveRuntimeState` keeps the state ledger, not the turn.
          await tasks.clearTask(bridge, id, undefined, {
            preserveRuntimeState: true,
            allowCompacting: true,
          });
          assert.equal(tasks.state.getState(id).runtime.busy, null);
          return id;
        },
      },
      {
        name: "clearAgentRuntime",
        run: async () => {
          const id = createTask("reloaded");
          tasks.beginAgentTurn(id, { origin: "delegated" });
          tasks.clearAgentRuntime("test-agent");
          return id;
        },
      },
    ];

    for (const entry of cases) {
      it(`clears the slot after ${entry.name}`, async () => {
        const id = await entry.run();

        assert.equal(tasks.getTurn(id), null, "no live turn survives");
        assert.equal(tasks.activePrompts.has(id), false);

        // The next turn on this task is the user's, whatever ran before it.
        const next = deferred();
        openPrompts.push(next);
        const res = await makeRequest(
          port,
          "POST",
          `/api/v1/tasks/${id}/prompt`,
          JSON.stringify({ text: "next" }),
        );
        assert.equal(res.status, 202);
        assert.equal(tasks.getTurn(id)?.origin, "interactive");
        next.resolve();
        await waitFor(() => tasks.getTurn(id) === null);
      });
    }

    it("does not end the turn for a cancel, which is not a terminal", async () => {
      const id = createTask("cancel-keeps");
      tasks.beginAgentTurn(id, { origin: "delegated" });
      let cancels = 0;
      bridge.cancel = async () => {
        cancels += 1;
      };

      const result = await tasks.cancelTaskExecution(id, bridge, 0);

      assert.equal(cancels, 1);
      assert.equal(result.status, "cancelling");
      assert.equal(
        tasks.getTurn(id)?.origin,
        "delegated",
        "the turn ends on its own terminal, not on the cancel request",
      );

      // The real terminal still ends it.
      finishPrompt(id);
      assert.equal(tasks.getTurn(id), null);
    });

    it("clears only the reloaded agent's turns", () => {
      const mine = createTask("mine");
      store.createTask(
        "theirs",
        tmpDir,
        "auto",
        "other-agent",
        "theirs-session",
      );
      tasks.liveTasks.add("theirs");
      tasks.beginAgentTurn(mine, { origin: "delegated" });
      tasks.beginAgentTurn("theirs", { origin: "interactive" });

      tasks.clearAgentRuntime("test-agent");

      assert.equal(tasks.getTurn(mine), null);
      assert.equal(tasks.getTurn("theirs")?.origin, "interactive");
    });
  });

  describe("superseded turns", () => {
    it("does not let a late finally release the turn that replaced it", () => {
      const id = createTask("superseded");
      tasks.beginAgentTurn(id, { origin: "delegated" });
      const oldPromptId = tasks.getTurn(id)?.promptId;
      assert.ok(oldPromptId);

      assert.equal(tasks.endTurn(id, { promptId: oldPromptId }), true);
      tasks.beginAgentTurn(id, { origin: "interactive" });
      const newPromptId = tasks.getTurn(id)?.promptId ?? undefined;
      assert.ok(newPromptId);
      assert.notEqual(newPromptId, oldPromptId);

      // The superseded turn's own terminal callback lands late.
      assert.equal(tasks.endTurn(id, { promptId: oldPromptId }), false);
      const turn = tasks.getTurn(id);
      assert.ok(turn, "the replacement turn is still live");
      assert.equal(turn.origin, "interactive");
      assert.equal(turn.promptId, newPromptId);
    });

    it("does not let a superseded prompt_done clear the replacement turn", () => {
      const id = createTask("late-done");
      tasks.beginAgentTurn(id, { origin: "delegated" });
      const oldPromptId =
        tasks.state.getState(id).runtime.busy?.promptId ?? undefined;
      tasks.endTurn(id, { promptId: oldPromptId });
      tasks.beginAgentTurn(id, { origin: "interactive" });

      // A completion event for the turn that already ended.
      emit({
        type: "prompt_done",
        taskId: id,
        stopReason: "end_turn",
        promptId: oldPromptId,
      });

      assert.equal(tasks.getTurn(id)?.origin, "interactive");
    });

    it("replaces the origin of every new turn instead of inheriting it", () => {
      const id = createTask("origin-per-turn");
      tasks.beginAgentTurn(id, { origin: "delegated" });
      assert.equal(tasks.getTurn(id)?.origin, "delegated");
      tasks.endTurn(id);
      assert.equal(tasks.getTurn(id), null);

      tasks.beginAgentTurn(id, { origin: "interactive" });
      assert.equal(tasks.getTurn(id)?.origin, "interactive");
    });
  });

  describe("submission protocol", () => {
    it("stops a drain while another submission holds the slot", async () => {
      createTask("source");
      const id = createTask("target");
      store.createCollaborationMessage({
        id: "m1",
        deliveryId: "d1",
        sourceTaskId: "source",
        directTargetTaskId: id,
        sourceActor: "agent",
        body: "dispatch",
        createdAt: 1,
      });
      const reservation = tasks.reservePromptSubmission(id);
      assert.notEqual(reservation, null);

      assert.equal(await tasks.drainCollaborationDeliveries(id, bridge), false);
      assert.equal(tasks.getTurn(id), null);
      assert.equal(store.getCollaborationDelivery("d1")?.status, "queued");

      tasks.releasePromptSubmission(id, reservation!);
      const pending = deferred();
      openPrompts.push(pending);
      assert.equal(await tasks.drainCollaborationDeliveries(id, bridge), true);
      assert.equal(tasks.getTurn(id)?.origin, "delegated");
      pending.resolve();
      await waitFor(() => store.getTask(id)?.workflow_status === "running");
      finishPrompt(id);
      await waitFor(() => tasks.getTurn(id) === null);
    });

    it("refuses an interactive submission while a drain holds the slot", async () => {
      createTask("source");
      const id = createTask("target");
      store.createCollaborationMessage({
        id: "m1",
        deliveryId: "d1",
        sourceTaskId: "source",
        directTargetTaskId: id,
        sourceActor: "agent",
        body: "dispatch",
        createdAt: 1,
      });
      const pending = deferred();
      openPrompts.push(pending);
      assert.equal(await tasks.drainCollaborationDeliveries(id, bridge), true);

      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${id}/prompt`,
        JSON.stringify({ text: "competing" }),
      );
      assert.equal(res.status, 409);
      assert.equal(bodyOf(res).busyKind, "agent");
      assert.equal(tasks.getTurn(id)?.origin, "delegated");

      pending.resolve();
      await waitFor(() => store.getTask(id)?.workflow_status === "running");
      finishPrompt(id);
      await waitFor(() => tasks.getTurn(id) === null);
    });

    it("holds the slot across the resume and gives it up if it is invalidated", async () => {
      createTask("source");
      const id = createTask("target");
      // Force the drain through `ensureResumed`, which is the await the slot
      // must survive; the resume is settled by the test.
      tasks.liveTasks.delete(id);
      const resumeGate = deferred();
      bridge.loadSession = async (taskId: string) => {
        await resumeGate.promise;
        return { taskId, configOptions: [] };
      };
      store.createCollaborationMessage({
        id: "m1",
        deliveryId: "d1",
        sourceTaskId: "source",
        directTargetTaskId: id,
        sourceActor: "agent",
        body: "dispatch",
        createdAt: 1,
      });

      const drain = tasks.drainCollaborationDeliveries(id, bridge);
      await waitFor(() => tasks.pendingPromptSubmissions.has(id), {
        message: "the drain took the slot before the resume",
      });
      assert.equal(tasks.getTurn(id), null, "the turn is not open yet");
      assert.equal(
        await makeRequest(
          port,
          "POST",
          `/api/v1/tasks/${id}/prompt`,
          JSON.stringify({ text: "competing" }),
        ).then((res) => res.status),
        409,
        "an interactive submit waits behind the runtime reservation",
      );

      // A cancel during the resume invalidates the reservation.
      tasks.cancelPendingPromptSubmission(id);
      resumeGate.resolve();

      assert.equal(await drain, false);
      assert.equal(tasks.getTurn(id), null);
      assert.equal(store.getCollaborationDelivery("d1")?.status, "queued");
    });

    it("drops a reservation once a cancel invalidates it", () => {
      const id = createTask("cancelled");
      const reservation = tasks.reservePromptSubmission(id);
      assert.ok(reservation !== null);
      assert.equal(tasks.ownsPromptReservation(id, reservation), true);

      tasks.cancelPendingPromptSubmission(id);
      assert.equal(tasks.ownsPromptReservation(id, reservation), false);
      assert.equal(tasks.getTurn(id), null);
    });

    it("gives each real submission its own turn identity on the transport", async () => {
      createTask("source");
      const id = createTask("identity");

      // 1. the person's turn, through the route
      const interactive = deferred();
      openPrompts.push(interactive);
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${id}/prompt`,
        JSON.stringify({ text: "mine" }),
      );
      assert.equal(res.status, 202);
      const firstTurn = tasks.getTurn(id);
      assert.ok(firstTurn);
      assert.equal(firstTurn.origin, "interactive");
      const firstCall = lastPromptCall(id);
      assert.ok(
        firstCall?.promptId,
        "the transport was handed this turn's identity",
      );
      assert.equal(firstCall.promptId, firstTurn.promptId);
      const firstPromptId = firstCall.promptId;
      interactive.resolve();
      await waitFor(() => tasks.getTurn(id) === null);

      // The dispatch is queued only now, so finishing the turn above has no
      // delivery to recover and cannot open a turn behind the test's back.
      store.createCollaborationMessage({
        id: "m1",
        deliveryId: "d1",
        sourceTaskId: "source",
        directTargetTaskId: id,
        sourceActor: "agent",
        body: "dispatch",
        createdAt: 1,
      });

      // 2. the runtime's turn
      const delegated = deferred();
      openPrompts.push(delegated);
      assert.equal(await tasks.drainCollaborationDeliveries(id), true);
      const secondTurn = tasks.getTurn(id);
      assert.ok(secondTurn);
      assert.equal(
        secondTurn.origin,
        "delegated",
        "a new turn assigns its own origin instead of inheriting the previous one",
      );
      const secondCall = lastPromptCall(id);
      assert.ok(secondCall?.promptId);
      assert.equal(secondCall.promptId, secondTurn.promptId);
      assert.notEqual(
        secondCall.promptId,
        firstPromptId,
        "two real prompts never share one turn identity",
      );

      delegated.resolve();
      finishPrompt(id);
      await waitFor(() => tasks.getTurn(id) === null);
    });
  });

  describe("transport-await competition", () => {
    /**
     * Hold the next transport resolution open. With no transport bound, this is
     * the cold start inside `resolveDeliveryTransport` — the window a first
     * gate check cannot see.
     */
    function parkNextResolve(): () => void {
      const released = deferred();
      environment.gate = released.promise;
      environment.holdCalls = 1;
      return released.resolve;
    }

    it("gives up the drain when an interactive submit takes the slot while the transport resolves", async () => {
      createTask("source");
      const id = createTask("cold");
      store.createCollaborationMessage({
        id: "m1",
        deliveryId: "d1",
        sourceTaskId: "source",
        directTargetTaskId: id,
        sourceActor: "agent",
        body: "dispatch",
        createdAt: 1,
      });
      unbindTransport();
      const releaseResolve = parkNextResolve();

      // The first gate check passes (the task is idle) and the drain parks in
      // the transport resolution.
      const drain = tasks.drainCollaborationDeliveries(id);
      await waitFor(
        () => environment.resolveCalls === 1 && environment.holdCalls === 0,
        { message: "the drain reached the transport await" },
      );
      assert.equal(tasks.getTurn(id), null, "the drain has not opened a turn");

      // The agent finishes starting, and a person submits through the route
      // while the drain is still resolving.
      tasks.attachExecutionBridge(bridge);
      const interactive = deferred();
      openPrompts.push(interactive);
      const res = await makeRequest(
        port,
        "POST",
        `/api/v1/tasks/${id}/prompt`,
        JSON.stringify({ text: "mine" }),
      );
      assert.equal(res.status, 202);
      const interactiveTurn = tasks.getTurn(id);
      assert.ok(interactiveTurn);
      assert.equal(interactiveTurn.origin, "interactive");

      // Only now does the drain's transport arrive.
      releaseResolve();
      assert.equal(
        await drain,
        false,
        "the drain re-checks admission after the transport await and gives up",
      );

      assert.equal(
        promptCallsFor(id).length,
        1,
        "no second real prompt reached the bridge",
      );
      assert.equal(
        tasks.getTurn(id)?.origin,
        "interactive",
        "the winner keeps its origin",
      );
      assert.equal(tasks.getTurn(id)?.promptId, interactiveTurn.promptId);
      assert.equal(
        store.getCollaborationDelivery("d1")?.status,
        "queued",
        "nothing was claimed",
      );
      assert.equal(
        store
          .getEvents(id)
          .some((event) => event.type === "collaboration_prompt"),
        false,
        "no prompt audit was written",
      );

      // Once the person's turn ends, the queued delivery gets its own turn.
      const delegated = deferred();
      openPrompts.push(delegated);
      finishPrompt(id);
      await waitFor(() => tasks.getTurn(id)?.origin === "delegated", {
        message: "the queued delivery opens its own delegated turn",
      });
      const delegatedTurn = tasks.getTurn(id);
      assert.ok(delegatedTurn);
      const delegatedCall = lastPromptCall(id);
      assert.ok(delegatedCall?.promptId);
      assert.equal(delegatedCall.promptId, delegatedTurn.promptId);
      assert.notEqual(
        delegatedCall.promptId,
        interactiveTurn.promptId,
        "each real prompt kept its own turn identity",
      );
      delegated.resolve();
      finishPrompt(id);
      await waitFor(() => tasks.getTurn(id) === null);
    });

    it("gives up the closing reminder when a submitter takes the slot while the transport resolves", async () => {
      const obligation = seedReminder({ live: true });
      unbindTransport();
      const releaseResolve = parkNextResolve();

      const reminder = tasks.submitObligationReminder(obligation);
      await waitFor(
        () => environment.resolveCalls === 1 && environment.holdCalls === 0,
        { message: "the reminder reached the transport await" },
      );
      assert.equal(
        tasks.getTurn("child"),
        null,
        "the reminder has not opened a turn or taken the slot yet",
      );

      tasks.attachExecutionBridge(bridge);
      const interactive = deferred();
      openPrompts.push(interactive);
      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks/child/prompt",
        JSON.stringify({ text: "mine" }),
      );
      assert.equal(res.status, 202);
      const interactiveTurn = tasks.getTurn("child");
      assert.ok(interactiveTurn);
      assert.equal(interactiveTurn.origin, "interactive");

      releaseResolve();
      assert.deepEqual(
        await reminder,
        { status: "deferred", reason: "busy" },
        "the reminder defers instead of submitting alongside the person's turn",
      );
      assert.equal(
        promptCallsFor("child").length,
        1,
        "only the person's prompt reached the bridge",
      );
      assert.equal(tasks.getTurn("child")?.origin, "interactive");

      // Freed again, the reminder still gets its own turn. Its submission
      // resolves at the end of that turn, so the prompt is settled first.
      finishPrompt("child");
      await waitFor(() => tasks.getTurn("child") === null);
      const reminderPrompt = deferred();
      openPrompts.push(reminderPrompt);
      const submission = tasks.submitObligationReminder(obligation);
      await waitFor(() => tasks.getTurn("child")?.origin === "delegated", {
        message: "the reminder opens its own delegated turn",
      });
      const reminderTurn = tasks.getTurn("child");
      assert.ok(reminderTurn);
      const reminderCall = lastPromptCall("child");
      assert.ok(reminderCall?.promptId);
      assert.equal(reminderCall.promptId, reminderTurn.promptId);
      assert.notEqual(reminderCall.promptId, interactiveTurn.promptId);
      reminderPrompt.resolve();
      assert.deepEqual(await submission, { status: "delivered" });
      await waitFor(() => tasks.getTurn("child") === null);
    });
  });

  describe("admission matrix", () => {
    /** Every busy source, armed through its own API where one exists. */
    function busySources(): Array<{
      name: string;
      arm: (taskId: string) => void;
      disarm: (taskId: string) => void;
    }> {
      const reservations = new Map<string, number>();
      return [
        {
          name: "a creation",
          arm: (id) => tasks.creatingTasks.add(id),
          disarm: (id) => tasks.creatingTasks.delete(id),
        },
        {
          name: "a restore",
          arm: (id) => tasks.restoringTasks.add(id),
          disarm: (id) => tasks.restoringTasks.delete(id),
        },
        {
          name: "a reserved submission",
          arm: (id) => {
            const reservation = tasks.reservePromptSubmission(id);
            assert.notEqual(reservation, null);
            reservations.set(id, reservation!);
          },
          disarm: (id) => {
            tasks.releasePromptSubmission(id, reservations.get(id)!);
            reservations.delete(id);
          },
        },
        {
          name: "a live turn",
          arm: (id) => {
            tasks.beginAgentTurn(id, { origin: "delegated" });
          },
          disarm: (id) => tasks.endTurn(id),
        },
        {
          name: "compaction",
          arm: (id) => tasks.compactingTasks.add(id),
          disarm: (id) => tasks.compactingTasks.delete(id),
        },
        {
          name: "a reset barrier",
          arm: (id) => tasks.resettingTasks.add(id),
          disarm: (id) => tasks.resettingTasks.delete(id),
        },
        {
          name: "a rotation",
          arm: (id) => tasks.rotatingTasks.add(id),
          disarm: (id) => tasks.rotatingTasks.delete(id),
        },
        {
          name: "a drain in progress",
          arm: (id) => tasks.drainingCollaborationTasks.add(id),
          disarm: (id) => tasks.drainingCollaborationTasks.delete(id),
        },
      ];
    }

    for (const source of busySources()) {
      it(`refuses both admission routes while ${source.name} holds the task`, () => {
        const id = createTask(`matrix-${source.name.replaceAll(" ", "-")}`);
        source.arm(id);
        try {
          // The gate face: a restore is busy here but invisible to rendering.
          assert.equal(tasks.getGateBusyKind(id), "agent");
          assert.equal(
            tasks.reservePromptSubmission(id),
            null,
            "the interactive route is refused",
          );
          assert.equal(
            tasks.reservePromptSubmission(id, { allowBash: true }),
            null,
            "the runtime route is refused too: allowBash opens only bash",
          );
        } finally {
          source.disarm(id);
        }
        assert.equal(
          tasks.getGateBusyKind(id),
          null,
          "the source is gone again",
        );
      });
    }

    it("opens bash for a runtime submission and nothing else", () => {
      const id = createTask("matrix-bash");
      // Only membership in `runningBashProcs` matters here; the slot logic
      // never touches the handle, so a bare object stands in for the process.
      tasks.runningBashProcs.set(id, {} as unknown as ChildProcess);
      try {
        assert.equal(tasks.getBusyKind(id), "bash");
        assert.equal(
          tasks.reservePromptSubmission(id),
          null,
          "an interactive submit still refuses a task running bash",
        );
        const reservation = tasks.reservePromptSubmission(id, {
          allowBash: true,
        });
        assert.notEqual(reservation, null);
        tasks.releasePromptSubmission(id, reservation!);
      } finally {
        tasks.runningBashProcs.delete(id);
      }
    });

    it("waives a restore only when the caller asks for it", () => {
      const id = createTask("matrix-restore-waived");
      tasks.restoringTasks.add(id);
      try {
        assert.equal(
          tasks.reservePromptSubmission(id, { allowBash: true }),
          null,
        );
        const reservation = tasks.reservePromptSubmission(id, {
          allowRestoring: true,
        });
        assert.notEqual(reservation, null);
        tasks.releasePromptSubmission(id, reservation!);
      } finally {
        tasks.restoringTasks.delete(id);
      }
    });
  });

  describe("bash is not an ACP turn", () => {
    it("lets a delegated turn open beside a running bash command", async () => {
      createTask("source");
      const id = createTask("target");
      // A handle this slot logic never touches: only its presence in
      // `runningBashProcs` matters, so a bare object is cast to the real type.
      tasks.runningBashProcs.set(id, {} as unknown as ChildProcess);
      store.createCollaborationMessage({
        id: "m1",
        deliveryId: "d1",
        sourceTaskId: "source",
        directTargetTaskId: id,
        sourceActor: "agent",
        body: "dispatch",
        createdAt: 1,
      });
      const pending = deferred();
      openPrompts.push(pending);

      assert.equal(await tasks.drainCollaborationDeliveries(id, bridge), true);
      assert.equal(tasks.getTurn(id)?.origin, "delegated");
      assert.equal(tasks.getBusyKind(id), "agent");

      pending.resolve();
      await waitFor(() => store.getTask(id)?.workflow_status === "running");
      finishPrompt(id);
      await waitFor(() => tasks.getTurn(id) === null);
      // Closing the ACP turn leaves only the bash run busy.
      assert.equal(tasks.getBusyKind(id), "bash");
    });

    it("does not open a turn for a task that is only running bash", () => {
      const id = createTask("bash-only");
      // A handle this slot logic never touches: only its presence in
      // `runningBashProcs` matters, so a bare object is cast to the real type.
      tasks.runningBashProcs.set(id, {} as unknown as ChildProcess);
      tasks.syncBusy(id);

      assert.equal(tasks.getTurn(id), null);
      assert.equal(tasks.getBusyKind(id), "bash");
    });
  });

  describe("deletion entries", () => {
    /**
     * Deletion has exactly one production entry: the REST route. It gates on
     * the same turn facts the slot reports, so a live turn is refused rather
     * than silently dropped, and the release paths below run on an idle tree.
     */
    function deleteRequest(taskId: string) {
      return makeRequest(port, "DELETE", `/api/v1/tasks/${taskId}`);
    }

    it("refuses a REST delete during a turn, then releases the slot on the next attempt", async () => {
      const id = createTask("busy-delete");
      tasks.beginAgentTurn(id, { origin: "delegated" });
      const before = tasks.getTurn(id);
      assert.ok(before);

      const refused = await deleteRequest(id);

      assert.equal(refused.status, 409);
      const refusal = bodyOf(refused).error;
      assert.ok(refusal, "the refusal names the busy work");
      assert.match(refusal, /Cancel active work/);
      assert.ok(store.getTask(id), "a refused delete keeps the row");
      const after = tasks.getTurn(id);
      assert.ok(after, "a refused delete must not release the turn");
      assert.equal(after.origin, "delegated");
      assert.equal(after.promptId, before.promptId);

      // The turn's own terminal frees the task; the same route now goes through.
      finishPrompt(id);
      await waitFor(() => tasks.getTurn(id) === null);
      const deleted = await deleteRequest(id);

      assert.equal(deleted.status, 200);
      assert.equal(bodyOf(deleted).reset, false);
      assert.equal(store.getTask(id), undefined, "the row is gone");
      assert.equal(tasks.getTurn(id), null, "no turn survives the delete");
      assert.equal(
        tasks.liveTasks.has(id),
        false,
        "the delete released the task's runtime",
      );
    });

    it("deletes one task without touching another task's turn", async () => {
      const victim = createTask("delete-victim");
      const bystander = createTask("delete-bystander");
      tasks.beginAgentTurn(bystander, { origin: "interactive" });
      const bystanderTurn = tasks.getTurn(bystander);
      assert.ok(bystanderTurn);

      const res = await deleteRequest(victim);

      assert.equal(res.status, 200);
      assert.equal(store.getTask(victim), undefined);
      assert.equal(tasks.getTurn(victim), null);
      assert.equal(tasks.liveTasks.has(victim), false);
      const survivor = tasks.getTurn(bystander);
      assert.ok(survivor, "another task's turn must survive the delete");
      assert.equal(survivor.origin, "interactive");
      assert.equal(survivor.promptId, bystanderTurn.promptId);
    });

    it("releases every task a cascading delete removes", async () => {
      const parent = createTask("cascade-parent");
      const child = createTask("cascade-child", parent);
      const bystander = createTask("cascade-bystander");
      tasks.beginAgentTurn(bystander, { origin: "interactive" });

      const res = await deleteRequest(parent);

      assert.equal(res.status, 200);
      for (const id of [parent, child]) {
        assert.equal(store.getTask(id), undefined, `${id} row is gone`);
        assert.equal(tasks.getTurn(id), null, `${id} has no turn`);
        assert.equal(
          tasks.liveTasks.has(id),
          false,
          `${id} runtime is released`,
        );
      }
      assert.equal(tasks.getTurn(bystander)?.origin, "interactive");
    });

    it("refuses a cascading delete while a descendant holds a turn", async () => {
      const parent = createTask("cascade-busy-parent");
      const child = createTask("cascade-busy-child", parent);
      tasks.beginAgentTurn(child, { origin: "delegated" });

      const res = await deleteRequest(parent);

      assert.equal(res.status, 409);
      const refusal = bodyOf(res).error;
      assert.ok(refusal, "the refusal names the busy descendant");
      assert.match(refusal, /cascade-busy-child/);
      assert.ok(store.getTask(parent), "the parent survives");
      assert.ok(store.getTask(child), "the child survives");
      assert.equal(
        tasks.getTurn(child)?.origin,
        "delegated",
        "the descendant's turn is untouched",
      );
    });

    it("releases the whole subtree through the Root reset route", async () => {
      const first = createTask("root-reset-first");
      const second = createTask("root-reset-second", first);
      const rootTaskId = store.rootTaskId;
      // A reset of the whole tree is refused while anything is busy, so this
      // asserts the release on the runtime bookkeeping every affected task owns.
      const res = await deleteRequest(rootTaskId);

      assert.equal(res.status, 200);
      assert.equal(bodyOf(res).reset, true);
      for (const id of [first, second]) {
        assert.equal(store.getTask(id), undefined, `${id} row is gone`);
        assert.equal(tasks.getTurn(id), null, `${id} has no turn`);
        assert.equal(
          tasks.liveTasks.has(id),
          false,
          `${id} runtime is released`,
        );
      }
      // Root keeps its own row as the tree anchor, and loses its runtime.
      assert.ok(store.getTask(rootTaskId), "Root survives its reset");
      assert.equal(tasks.getTurn(rootTaskId), null);
      assert.equal(tasks.liveTasks.has(rootTaskId), false);
    });

    it("releases a task the empty-task sweep removes", async () => {
      // The sweep only picks tasks with zero events older than
      // `EMPTY_TASK_MIN_AGE_S`, and the age is a module constant, so the row is
      // aged here to reach the sweep through its real entry: the next create.
      const swept = createTask("empty-swept");
      tasks.beginAgentTurn(swept, { origin: "delegated" });
      assert.equal(store.getEvents(swept).length, 0, "the task is empty");
      // `db` is the store's private handle and `created_at` has no setter, so
      // the row is aged through the real database type to reach the sweep.
      (store as unknown as { db: Database.Database }).db
        .prepare("UPDATE tasks SET created_at = ? WHERE id = ?")
        .run(Date.now() - 2 * 60 * 1000, swept);

      const res = await makeRequest(
        port,
        "POST",
        "/api/v1/tasks",
        JSON.stringify({ cwd: tmpDir }),
      );

      assert.equal(res.status, 201);
      assert.equal(
        store.getTask(swept),
        undefined,
        "the sweep removed the row",
      );
      assert.equal(tasks.getTurn(swept), null, "the sweep released the slot");
      assert.equal(
        tasks.activePrompts.has(swept),
        false,
        "the slot's membership is released, not just its metadata",
      );
      assert.equal(tasks.liveTasks.has(swept), false);
    });
  });

  /**
   * Seed a real directed obligation on parent→child, with the delivery row
   * already settled so the idle edge does not start a delivery drain.
   */
  function seedReminder(opts: { live?: boolean } = {}): DirectedObligation {
    store.createTask("parent", tmpDir, "auto", "test-agent", "agent-parent");
    createTask("child", "parent");
    if (!opts.live) tasks.liveTasks.delete("child");
    store.createCollaborationMessage({
      id: "turn-ownership",
      deliveryId: "turn-ownership-delivery",
      sourceTaskId: "parent",
      directTargetTaskId: "child",
      sourceActor: "agent",
      body: "Dispatch.",
    });
    const claimed = store.claimQueuedDeliveries("child");
    store.markCollaborationDeliveriesDelivered(
      claimed.map((delivery) => delivery.id),
    );
    const obligation = tasks.getObligation("parent", "child");
    assert.ok(obligation);
    return obligation;
  }
});
