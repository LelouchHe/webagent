import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { projectTaskHistoryRow } from "../src/mcp/task-history.ts";
import { extractToolCallContent } from "../public/js/event-interpreter.ts";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import type { ToolContentItem } from "../src/types.ts";

/** A real 1x1 PNG: the payload an inline block would have carried. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=";

const CALL = { id: "tc-legacy", kind: "other", title: "Screenshot" };
const UPDATE = {
  id: "tc-legacy",
  status: "completed",
  content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
};

/**
 * A stored row that still holds the wire shape.
 *
 * This is not a compatibility target. Ingest is the only place the wire shape
 * is recognized, so a stored inline block is an `unknown` content shape: the
 * suite locks the consequence — the payload reaches no projection and no
 * render path — rather than a fallback that would make it a picture again.
 *
 * Boundary: `GET /api/v1/tasks/:id/events` serializes `store.getEvents` rows
 * verbatim (the raw-event contract), so the bytes stay inside this row's own
 * `data`. What must not happen is a projection or a render that turns them
 * into a picture or echoes them into visible text.
 */
describe("tool-result images: a stored inline block", () => {
  let dir: string;
  let store: Store;
  let state: any;
  let dom: any;
  let stateMod: any;
  let events: any;

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    events = await import("../public/js/events.ts");

    dir = mkdtempSync(join(tmpdir(), "webagent-legacy-tool-image-"));
    store = new Store(join(dir, "db"));
    store.createTask("t1", "/tmp", "auto", "test-agent");
    // Written straight to the store: no ingest, exactly as an old row would be.
    store.saveEvent("t1", "tool_call", CALL, { from_ref: "agent" });
    store.saveEvent("t1", "tool_call_update", UPDATE, { from_ref: "agent" });
  });

  after(() => {
    teardownDOM();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reaches no projection and no render path", () => {
    // `task_query`'s row projection: marked, named by nothing, echoed nowhere.
    const stored = store.getEvents("t1");
    const updateRow = stored.find((row) => row.type === "tool_call_update");
    assert.ok(updateRow);
    const projected = projectTaskHistoryRow(updateRow);
    assert.equal(projected.content_shape, "unknown");
    assert.equal(projected.text, undefined);
    assert.equal(projected.field, undefined);
    assert.equal(JSON.stringify(projected).includes(PNG_BASE64), false);

    // The frontend's text extractor agrees: an inline block contributes no text.
    assert.equal(
      extractToolCallContent(UPDATE.content as ToolContentItem[]),
      "",
    );

    // The client replays the same stored rows it fetches from `GET /events`.
    stateMod.resetTaskUI();
    resetState(state, dom);
    dom.messages.innerHTML = "";
    events.replayEvent("tool_call", CALL, [], 0);
    const rows = stored.map((row) => ({
      seq: row.seq,
      type: row.type,
      data: row.data,
    }));
    const index = rows.findIndex((row) => row.type === "tool_call_update");
    events.replayEvent("tool_call_update", UPDATE, rows, index);

    const card = document.getElementById("tc-tc-legacy")!;
    assert.ok(card, "the tool card still renders");
    assert.equal(card.querySelector(".tc-images"), null);
    assert.equal(card.querySelector("img.tc-image"), null);
    assert.equal(card.innerHTML.includes(PNG_BASE64), false);
    assert.equal(card.querySelector(".tc-content")?.textContent ?? "", "");
  });
});
