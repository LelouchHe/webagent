import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import type { AgentEvent } from "../src/types.ts";

/**
 * Every event row must persist a correct `from_ref`. These integration
 * tests exercise the backend writers end-to-end (Store + TaskManager
 * + event-handler) and assert the stored origin marker for each
 * category. Complements unit tests by pinning the cross-module contract.
 *
 * Categories:
 *   - agent : assistant_message, thinking, tool_call, tool_call_update,
 *             plan, permission_request, prompt_done
 *   - user  : user_message, bash_command (originate from POST /prompt
 *             and /bash user actions), permission_response (human click)
 *   - system: permission_response (autopilot auto-approve path),
 *             bash_result
 */
describe("event writers populate from_ref correctly", () => {
  let tmpDir: string;
  let store: Store;
  let tasks: TaskManager;
  let broadcasts: AgentEvent[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-fromref-"));
    store = new Store(tmpDir);
    tasks = createTaskManager(store, tmpDir, tmpDir);
    store.createTask("s1", "/tmp", "auto", "test-agent");
    broadcasts = [];
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const bridge = {
    resolvePermission: () => {},
  } as unknown as Parameters<typeof handleAgentEvent>[3];
  const sseManager = {
    broadcast: (event: AgentEvent) => {
      broadcasts.push(event);
    },
  } as unknown as Parameters<typeof handleAgentEvent>[5];
  function config() {
    return {
      cancelTimeout: 10000,
      recentPathsLimit: 10,
      dataDir: tmpDir,
      imageUploadLimit: 1024 * 1024,
    };
  }

  /**
   * Stamp an event the way the bridge does: with the lease of the execution
   * that produced it. The entry boundary refuses an unstamped event once the
   * task has a current execution, so a fabricated event must name one.
   */
  function withLease<T extends object>(event: T): T {
    const taskId = (event as { taskId?: unknown }).taskId;
    if (typeof taskId !== "string") return event;
    const lease = tasks.authority.leaseFor(taskId);
    return lease ? Object.assign({}, event, { executionLease: lease }) : event;
  }

  function emit(event: AgentEvent) {
    handleAgentEvent(
      withLease(event),
      tasks,
      store,
      bridge,
      config(),
      sseManager,
    );
  }

  it("assistant_message (flushed from buffer) is from_ref='agent'", () => {
    emit({ type: "message_chunk", taskId: "s1", text: "hi" });
    // Boundary event forces flush
    emit({ type: "prompt_done", taskId: "s1", stopReason: "end_turn" });

    const events = store.getEvents("s1");
    const asst = events.find((e) => e.type === "assistant_message");
    assert.ok(asst, "assistant_message should be stored");
    assert.equal(asst.from_ref, "agent");
    const done = events.find((e) => e.type === "prompt_done");
    assert.equal(done?.from_ref, "agent");
  });

  /** PNG-signature bytes, so the content sniffer accepts the payload. */
  const AGENT_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);

  it("agent_image stores an attachment and keeps its place among the text", () => {
    const base64 = AGENT_PNG.toString("base64");

    emit({ type: "message_chunk", taskId: "s1", text: "before" });
    emit({
      type: "agent_image",
      taskId: "s1",
      block: { mimeType: "image/png", data: base64 },
    });
    emit({ type: "message_chunk", taskId: "s1", text: "after" });
    emit({ type: "prompt_done", taskId: "s1", stopReason: "end_turn" });

    const content = store
      .getEvents("s1")
      .filter(
        (event) =>
          event.type === "assistant_message" || event.type === "agent_image",
      );
    // The image is its own record, so a replay keeps text → image → text
    // instead of glueing the image into a text block.
    assert.deepEqual(
      content.map((event) => event.type),
      ["assistant_message", "agent_image", "assistant_message"],
    );
    assert.deepEqual(JSON.parse(content[0].data), { text: "before" });
    assert.deepEqual(JSON.parse(content[2].data), { text: "after" });
    assert.equal(content[1].from_ref, "agent");

    // The bytes are NOT in the transcript: only a reference to the stored
    // attachment, in the shape a user's attachment already uses.
    assert.equal(
      content[1].data.includes(base64),
      false,
      "the persisted event must not carry base64",
    );
    const attachment = (
      JSON.parse(content[1].data) as {
        attachment: {
          kind: string;
          attachmentId: string;
          displayName: string;
          mimeType: string;
          path: string;
        };
      }
    ).attachment;
    assert.equal(attachment.kind, "image");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.displayName, "agent-image-1");
    assert.match(
      attachment.path,
      /^\/api\/v1\/tasks\/s1\/attachments\/[0-9a-f-]+\.png$/,
    );

    // The row and the file are the same thing the path names.
    const row = store.getAttachment("s1", attachment.attachmentId);
    assert.ok(row, "an attachments row must exist");
    assert.equal(row.kind, "image");
    assert.ok(existsSync(row.realpath));
    assert.equal(basename(row.realpath), attachment.path.split("/").pop());

    // The live broadcast carries the same reference, never the bytes.
    const live = broadcasts.find((event) => event.type === "agent_image");
    assert.ok(live);
    assert.deepEqual(live, {
      type: "agent_image",
      taskId: "s1",
      attachment,
    });
    assert.equal(JSON.stringify(live).includes(base64), false);
  });

  it("agent_image above the ceiling becomes visible text, with no row", () => {
    // Exactly 2 MiB, one MiB over the limit configured above.
    const bytes = Buffer.concat([
      AGENT_PNG,
      Buffer.alloc(2 * 1024 * 1024 - AGENT_PNG.length, 7),
    ]);

    emit({
      type: "agent_image",
      taskId: "s1",
      block: { mimeType: "image/png", data: bytes.toString("base64") },
    });
    emit({ type: "prompt_done", taskId: "s1", stopReason: "end_turn" });

    const events = store.getEvents("s1");
    assert.equal(
      events.some((event) => event.type === "agent_image"),
      false,
      "an oversized image is never stored",
    );
    const text = events
      .filter((event) => event.type === "assistant_message")
      .map((event) => (JSON.parse(event.data) as { text: string }).text);
    assert.ok(
      text.some((value) =>
        /^\[image omitted: 2 MB > 1 MB limit\]$/.test(value),
      ),
      `expected the placeholder, got ${JSON.stringify(text)}`,
    );
    assert.equal(store.countAttachments("s1", "image"), 0);
    assert.equal(
      broadcasts.some((event) => event.type === "agent_image"),
      false,
    );
    const liveText = broadcasts.find(
      (event) => event.type === "message_chunk",
    ) as { text?: string } | undefined;
    assert.match(
      String(liveText?.text),
      /\[image omitted: 2 MB > 1 MB limit\]/,
    );
  });

  it("thinking (flushed from buffer) is from_ref='agent'", () => {
    emit({ type: "thought_chunk", taskId: "s1", text: "hmm" });
    emit({
      type: "tool_call",
      taskId: "s1",
      id: "t1",
      title: "read",
      kind: "read",
    });
    const events = store.getEvents("s1");
    const thinking = events.find((e) => e.type === "thinking");
    assert.ok(thinking);
    assert.equal(thinking.from_ref, "agent");
  });

  it("tool_call is from_ref='agent'", () => {
    emit({
      type: "tool_call",
      taskId: "s1",
      id: "t1",
      title: "read",
      kind: "read",
    });
    const ev = store.getEvents("s1").find((e) => e.type === "tool_call");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("tool_call_update is from_ref='agent'", () => {
    emit({
      type: "tool_call_update",
      taskId: "s1",
      id: "t1",
      status: "completed",
      rawOutput: { details: { progress: 100 } },
    });
    const ev = store.getEvents("s1").find((e) => e.type === "tool_call_update");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
    assert.equal(
      Object.hasOwn(JSON.parse(ev.data), "rawOutput"),
      false,
      "rawOutput is live-only and must not be persisted",
    );
  });

  it("plan is from_ref='agent'", () => {
    emit({
      type: "plan",
      taskId: "s1",
      entries: [{ content: "do a thing", status: "pending" }],
    });
    const ev = store.getEvents("s1").find((e) => e.type === "plan");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("permission_request is from_ref='agent' (agent asked for permission)", () => {
    emit({
      type: "permission_request",
      taskId: "s1",
      requestId: "p1",
      title: "Read file",
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });
    const ev = store
      .getEvents("s1")
      .find((e) => e.type === "permission_request");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("prompt_done is from_ref='agent'", () => {
    emit({ type: "prompt_done", taskId: "s1", stopReason: "end_turn" });
    const ev = store.getEvents("s1").find((e) => e.type === "prompt_done");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("autopilot auto-approve writes permission_response with from_ref='system'", () => {
    // Put task in autopilot mode so the auto-approve branch fires.
    store.updateTaskConfig("s1", "mode", "agent#autopilot");
    emit({
      type: "permission_request",
      taskId: "s1",
      requestId: "p2",
      title: "Read file",
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });
    const resp = store
      .getEvents("s1")
      .find((e) => e.type === "permission_response");
    assert.ok(resp, "auto-approve should persist a permission_response row");
    assert.equal(resp.from_ref, "system");
  });

  // --- routes.ts contracts: user_message / bash_command / bash_result /
  // permission_response (human click) are written by REST handlers, not
  // event-handler. We pin the contract via direct Store calls.

  it("direct saveEvent with from_ref='user' round-trips (routes.ts user_message contract)", () => {
    store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
    const [ev] = store.getEvents("s1");
    assert.equal(ev.from_ref, "user");
  });

  it("bash_command='user' / bash_result='system' (routes.ts bash contract)", () => {
    store.saveEvent(
      "s1",
      "bash_command",
      { command: "ls" },
      { from_ref: "user" },
    );
    store.saveEvent(
      "s1",
      "bash_result",
      { output: "a.txt\n", code: 0, signal: null },
      { from_ref: "system" },
    );
    const events = store.getEvents("s1");
    assert.equal(events[0].from_ref, "user");
    assert.equal(events[1].from_ref, "system");
  });

  it("permission_response (human click) is from_ref='user'", () => {
    store.saveEvent(
      "s1",
      "permission_response",
      {
        requestId: "p1",
        optionName: "Allow",
        denied: false,
        optionId: "allow_once",
      },
      { from_ref: "user" },
    );
    const [ev] = store.getEvents("s1");
    assert.equal(ev.type, "permission_response");
    assert.equal(ev.from_ref, "user");
  });

  // Guard: missing from_ref is a programming error. Throws instead of
  // silently defaulting — any writer retrofit regression surfaces in tests.
  it("saveEvent without from_ref THROWS (guard is active)", () => {
    assert.throws(
      () => store.saveEvent("s1", "assistant_message", { text: "x" }),
      /from_ref/,
    );
  });
});
