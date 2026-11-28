import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Store } from "../src/store.ts";
import { createTaskManager, type TaskManager } from "../src/task-manager.ts";
import {
  TASK_HISTORY_LIMITS,
  toTaskQueryWire,
  toTaskReadWire,
} from "../src/task-history.ts";
import { createLocalTaskOps } from "./fixtures.ts";

describe("task history MCP wire byte budgets", () => {
  let dir: string;
  let store: Store;
  let tasks: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-history-budget-"));
    store = new Store(dir);
    store.ensureRootTask(dir);
    tasks = createTaskManager(store, dir, dir);
    tasks.hydrate();
    store.createTask("alpha", dir, "auto", "test-agent", "session-alpha");
  });

  afterEach(() => {
    tasks.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function principal(taskId = "alpha") {
    const lease = tasks.authority.leaseFor(taskId);
    assert.ok(lease);
    return {
      kind: "agent" as const,
      taskId,
      agentId: "test-agent",
      generation: lease.generation,
    };
  }

  it("enforces exact 24 KiB query budget on final MCP wire JSON with multi-byte text and content_shape rows", async () => {
    const host = createLocalTaskOps({ store, tasks });
    // Fill with rows that carry both `content_shape: "unknown"` (+1 wire byte
    // per row over camelCase `contentShape`) and multi-byte UTF-8 text.
    const fillerCount = 135;
    for (let i = 0; i < fillerCount; i++) {
      store.saveEvent(
        "alpha",
        "tool_call_update",
        {
          id: `call-${i}`,
          content: [
            {
              type: "content",
              content: { type: "text", text: "边界测试文本" },
            },
            { type: "future_unknown_block", payload: 1 },
          ],
        },
        { from_ref: "agent" },
      );
    }

    const baseQuery = await host.query(principal(), {});
    assert.equal(baseQuery.rows[0].contentShape, "unknown");
    const baseWireBytes = Buffer.byteLength(
      JSON.stringify(toTaskQueryWire(baseQuery)),
      "utf8",
    );
    assert.ok(
      baseWireBytes < TASK_HISTORY_LIMITS.queryBytes,
      `expected base wire size (${baseWireBytes}) < ${TASK_HISTORY_LIMITS.queryBytes}`,
    );

    // Pad with normal assistant_message rows until < 240 bytes remain, then
    // add one final row sized so the emitted MCP wire JSON hits 24 KiB exactly.
    let currentBytes = baseWireBytes;
    while (TASK_HISTORY_LIMITS.queryBytes - currentBytes > 320) {
      store.saveEvent(
        "alpha",
        "assistant_message",
        { text: "a".repeat(160) },
        { from_ref: "agent" },
      );
      const q = await host.query(principal(), {});
      currentBytes = Buffer.byteLength(
        JSON.stringify(toTaskQueryWire(q)),
        "utf8",
      );
    }

    // Measure overhead of adding one assistant_message row with empty text,
    // accounting for the `bytes` digit width changing as text grows.
    const probeSeq = store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "" },
      { from_ref: "agent" },
    ).seq;
    const probeQuery = await host.query(principal(), {});
    const probeWireBytes = Buffer.byteLength(
      JSON.stringify(toTaskQueryWire(probeQuery)),
      "utf8",
    );
    const remaining = TASK_HISTORY_LIMITS.queryBytes - probeWireBytes;
    assert.ok(remaining >= 2 && remaining <= 260);

    // Adjust `text` length on the probe row directly in SQLite so we hit
    // exact limit and exact limit + 1 byte without extra rows.
    const updateRow = (textLen: number) => {
      const data = JSON.stringify({ text: "x".repeat(textLen) });
      store["db"]
        .prepare("UPDATE events SET data = ? WHERE task_id = ? AND seq = ?")
        .run(data, "alpha", probeSeq);
    };

    let exactLen = remaining;
    for (let delta = -4; delta <= 4; delta++) {
      const candidate = remaining + delta;
      if (candidate < 0) continue;
      updateRow(candidate);
      try {
        const res = await host.query(principal(), {});
        const wireBytes = Buffer.byteLength(
          JSON.stringify(toTaskQueryWire(res)),
          "utf8",
        );
        if (wireBytes === TASK_HISTORY_LIMITS.queryBytes) {
          exactLen = candidate;
          break;
        }
      } catch {
        // Over limit; keep searching.
      }
    }

    // 1. Exact 24 KiB wire JSON succeeds.
    updateRow(exactLen);
    const atLimit = await host.query(principal(), {});
    const atLimitWire = toTaskQueryWire(atLimit);
    assert.equal(
      Buffer.byteLength(JSON.stringify(atLimitWire), "utf8"),
      TASK_HISTORY_LIMITS.queryBytes,
    );
    // Confirm camelCase internal object is strictly smaller than wire JSON
    // (because taskId, maxSeq, and every contentShape are 1 byte shorter).
    assert.ok(
      Buffer.byteLength(JSON.stringify(atLimit), "utf8") <=
        TASK_HISTORY_LIMITS.queryBytes - (2 + fillerCount),
    );
    // Preserve exact wire key order and optional omission.
    assert.deepEqual(Object.keys(atLimitWire), ["task_id", "max_seq", "rows"]);
    assert.deepEqual(Object.keys(atLimitWire.rows[0]), [
      "seq",
      "type",
      "bytes",
      "group",
      "content_shape",
      "field",
      "text",
    ]);

    // 2. Adding 1 byte (24 KiB + 1 wire bytes, still well under 24 KiB in
    // camelCase) must fail with exact wire required_bytes.
    updateRow(exactLen + 1);
    await assert.rejects(host.query(principal(), {}), (error: unknown) => {
      const parsed = JSON.parse((error as Error).message) as {
        error: string;
        required_bytes: number;
        limit_bytes: number;
      };
      assert.equal(parsed.error, "response_too_large");
      assert.equal(parsed.limit_bytes, TASK_HISTORY_LIMITS.queryBytes);
      assert.equal(parsed.required_bytes, TASK_HISTORY_LIMITS.queryBytes + 1);
      return true;
    });
  });

  it("enforces exact 128 KiB batch read and 1 MiB single-row read budgets on MCP wire JSON", async () => {
    const host = createLocalTaskOps({ store, tasks });
    const e1 = store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "", taskId: "keep-camel", task_id: "keep-snake" },
      { from_ref: "agent" },
    );
    const e2 = store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "" },
      { from_ref: "agent" },
    );

    const setPayload = (seq: number, extra: Record<string, unknown>) => {
      store["db"]
        .prepare("UPDATE events SET data = ? WHERE task_id = ? AND seq = ?")
        .run(JSON.stringify(extra), "alpha", seq);
    };

    // Batch read (2 rows -> 128 KiB limit).
    const baseBatch = await host.read(principal(), {
      seqs: [e1.seq, e2.seq],
    });
    const baseBatchBytes = Buffer.byteLength(
      JSON.stringify(toTaskReadWire(baseBatch)),
      "utf8",
    );
    const batchPad = TASK_HISTORY_LIMITS.readBytes - baseBatchBytes;
    setPayload(e2.seq, { text: "b".repeat(batchPad) });

    const exactBatch = await host.read(principal(), {
      seqs: [e1.seq, e2.seq],
    });
    const exactBatchWire = toTaskReadWire(exactBatch);
    assert.equal(
      Buffer.byteLength(JSON.stringify(exactBatchWire), "utf8"),
      TASK_HISTORY_LIMITS.readBytes,
    );
    // Raw data inside rows is never deep-renamed.
    assert.deepEqual(exactBatchWire.rows[0].data, {
      text: "",
      taskId: "keep-camel",
      task_id: "keep-snake",
    });

    // +1 byte pushes wire JSON to 128 KiB + 1 while camelCase JSON is
    // still exactly 128 KiB (taskId vs task_id = -1 byte). Must reject!
    setPayload(e2.seq, { text: "b".repeat(batchPad + 1) });
    await assert.rejects(
      host.read(principal(), { seqs: [e1.seq, e2.seq] }),
      (error: unknown) => {
        const parsed = JSON.parse((error as Error).message) as {
          error: string;
          required_bytes: number;
          limit_bytes: number;
        };
        assert.equal(parsed.error, "response_too_large");
        assert.equal(parsed.limit_bytes, TASK_HISTORY_LIMITS.readBytes);
        assert.equal(parsed.required_bytes, TASK_HISTORY_LIMITS.readBytes + 1);
        return true;
      },
    );

    // Single-row read (1 row -> 1 MiB limit).
    setPayload(e2.seq, { text: "" });
    const baseSingle = await host.read(principal(), { seqs: [e2.seq] });
    const baseSingleBytes = Buffer.byteLength(
      JSON.stringify(toTaskReadWire(baseSingle)),
      "utf8",
    );
    const singlePad = TASK_HISTORY_LIMITS.readSingleBytes - baseSingleBytes;
    setPayload(e2.seq, { text: "s".repeat(singlePad) });

    const exactSingle = await host.read(principal(), { seqs: [e2.seq] });
    assert.equal(
      Buffer.byteLength(JSON.stringify(toTaskReadWire(exactSingle)), "utf8"),
      TASK_HISTORY_LIMITS.readSingleBytes,
    );

    setPayload(e2.seq, { text: "s".repeat(singlePad + 1) });
    await assert.rejects(
      host.read(principal(), { seqs: [e2.seq] }),
      (error: unknown) => {
        const parsed = JSON.parse((error as Error).message) as {
          error: string;
          required_bytes: number;
          limit_bytes: number;
        };
        assert.equal(parsed.error, "response_too_large");
        assert.equal(parsed.limit_bytes, TASK_HISTORY_LIMITS.readSingleBytes);
        assert.equal(
          parsed.required_bytes,
          TASK_HISTORY_LIMITS.readSingleBytes + 1,
        );
        return true;
      },
    );

    // Core authorization still runs before the budget check.
    const stale = principal();
    store.replaceAgentSession("alpha", "test-agent", "session-alpha-v2");
    await assert.rejects(
      host.read(stale, { seqs: [e2.seq] }),
      /execution_replaced/,
    );
  });
});
