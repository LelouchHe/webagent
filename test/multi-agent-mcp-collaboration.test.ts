import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_A,
  AGENT_B,
  SCHEMA_A,
  SCHEMA_B,
  callTool,
  callTool as callMcpTool,
  createdTaskId,
  parentOnA,
  startHarness,
  toolResult,
  waitForPrompts,
  type Harness,
} from "./fixtures/mcp-multi-agent-harness.ts";

/**
 * The cross-agent collaboration loop, not just the creation call.
 *
 * A parent on A dispatches to a child on B through the real MCP tools; the
 * child really receives its first turn on B's transport, and its typed update
 * wakes the parent on A. Each case reads the transports' prompt arrays: "the
 * child was asked" is a fact about B's transport, and "the parent was woken" is
 * a fact about A's.
 */

const A = AGENT_A;
const B = AGENT_B;

function childUpdateEvents(
  harness: Harness,
  taskId: string,
): Array<{
  status?: unknown;
  body?: unknown;
  reason?: unknown;
  sourceTaskId?: unknown;
  targetTaskId?: unknown;
}> {
  return harness.store
    .getEvents(taskId)
    .filter((event) => event.type === "task_update")
    .map(
      (event) =>
        JSON.parse(event.data) as {
          status?: unknown;
          body?: unknown;
          reason?: unknown;
          sourceTaskId?: unknown;
          targetTaskId?: unknown;
        },
    );
}

describe("cross-agent collaboration", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  /** Parent on A, child created on B through the real tool, dispatch sent. */
  async function dispatchToChildOnB(): Promise<{
    parentId: string;
    childId: string;
    childToken: string;
  }> {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    const parent = await parentOnA(harness);
    assert.equal(harness.observerFacts.length, 0, "setup created no message");

    const created = await callMcpTool(harness, parent.token, "task_create", {
      title: "review on b",
      agent: B,
    });
    const childId = createdTaskId(created.json);
    assert.equal(harness.store.getBindingAgent(childId), B);
    const lease = harness.tasks.authority.leaseFor(childId);
    assert.ok(lease);
    const childToken = harness.capabilities.mint(childId, B, lease.generation);

    const sent = await callMcpTool(harness, parent.token, "task_send", {
      target: childId,
      body: "CHILD CONTRACT: review the auth flow",
    });
    assert.equal(toolResult(sent.json).isError, undefined);
    // The dispatch really reaches the target's own transport.
    await waitForPrompts(harness, B, 1);
    assert.equal(harness.agents[B].prompts[0].taskId, childId);
    assert.match(harness.agents[B].prompts[0].text, /CHILD CONTRACT/);
    assert.equal(
      harness.agents[A].prompts.length,
      0,
      "the parent's transport must not receive its own dispatch",
    );

    // One dispatch message, one production observer call, one open account.
    assert.ok(harness.tasks.hasOpenObligation(parent.taskId, childId));
    assert.equal(harness.observerFacts.length, 1);
    return { parentId: parent.taskId, childId, childToken };
  }

  it("wakes the parent on A with the child's account from B", async () => {
    const { parentId, childId, childToken } = await dispatchToChildOnB();

    const updated = await callTool(harness, childToken, "task_update", {
      status: "done",
      body: "finished the review",
    });
    assert.equal(toolResult(updated.json).isError, undefined);

    // The account settles the edge and is persisted as the typed update.
    assert.equal(harness.tasks.hasOpenObligation(parentId, childId), false);
    assert.equal(harness.store.getTask(childId)?.workflow_status, "done");
    const updates = childUpdateEvents(harness, childId);
    assert.equal(updates.length, 1, "the typed update is persisted once");
    assert.equal(updates[0].status, "done");
    assert.equal(updates[0].body, "finished the review");
    assert.equal(updates[0].reason, "settled");
    assert.equal(updates[0].sourceTaskId, childId);
    assert.equal(updates[0].targetTaskId, parentId);

    // The parent on A is woken through A's own transport with readable text.
    await waitForPrompts(harness, A, 1);
    const account = harness.agents[A].prompts[0].text;
    assert.match(account, /Task status: done/);
    assert.match(account, /finished the review/);
    assert.equal(
      account.includes('{"'),
      false,
      "the account is prose, not JSON",
    );
    assert.equal(
      harness.agents[B].prompts.length,
      1,
      "the child's transport received only the dispatch, not its own account",
    );

    // Two collaboration messages were created (dispatch, account): the
    // production observer saw each exactly once.
    assert.equal(harness.observerFacts.length, 2);
    assert.equal(
      new Set(harness.observerFacts.map((fact) => fact.messageId)).size,
      2,
    );
  });

  it("reminds once, then reports no_update without waking the source twice", async () => {
    const { parentId, childId } = await dispatchToChildOnB();

    // The dispatch turn ends without an update: one closing reminder.
    const dispatchPrompt = harness.agents[B].prompts[0];
    dispatchPrompt.resolve();
    harness.endTurn(childId, dispatchPrompt.promptId);

    await waitForPrompts(harness, B, 2);
    const reminder = harness.agents[B].prompts[1];
    assert.equal(reminder.taskId, childId);
    assert.match(reminder.text, /runtime-injected closing turn/i);
    assert.equal(
      harness.agents[A].prompts.length,
      0,
      "the reminder must not be delivered to the source's transport",
    );

    // That reminder turn also ends without an update: report `no_update` to
    // the source and stop reminding.
    reminder.resolve();
    harness.endTurn(childId, reminder.promptId);
    await waitForPrompts(harness, A, 1, "the no_update notice never reached A");
    const notice = harness.agents[A].prompts[0].text;
    assert.match(notice, /From the WebAgent runtime/);
    assert.match(notice, /^reason: no_update$/m);
    const targetLine = notice
      .split("\n")
      .find((line) => line.startsWith("target: "));
    assert.ok(
      targetLine?.includes(childId),
      "the notice names the target that failed to report",
    );
    assert.equal(notice.includes('{"'), false, "the notice is prose, not JSON");
    assert.equal(
      harness.agents[B].prompts.length,
      2,
      "no_update must not be delivered to the target",
    );
    assert.ok(harness.tasks.hasOpenObligation(parentId, childId));

    // The machine payload is persisted on the source.
    const noticeEvent = harness.store
      .getEvents(parentId)
      .filter((event) => event.type === "task_outcome_notice")
      .at(-1);
    assert.ok(noticeEvent, "the machine payload must be persisted");
    const payload = JSON.parse(noticeEvent.data) as Record<string, unknown>;
    assert.equal(payload.reason, "no_update");
    assert.equal(payload.sourceTaskId, parentId);
    assert.equal(payload.targetTaskId, childId);
  });

  it("records waiting without delivering, waking, or settling", async () => {
    const { parentId, childId, childToken } = await dispatchToChildOnB();

    const waiting = await callTool(harness, childToken, "task_update", {
      status: "waiting",
      body: "waiting on the other child",
    });
    assert.equal(toolResult(waiting.json).isError, undefined);

    assert.equal(harness.store.getTask(childId)?.workflow_status, "waiting");
    assert.ok(
      harness.tasks.hasOpenObligation(parentId, childId),
      "waiting does not settle the account",
    );
    const updates = childUpdateEvents(harness, childId);
    assert.equal(updates.at(-1)?.status, "waiting");
    assert.equal(
      harness.agents[A].prompts.length,
      0,
      "waiting must not wake the requester",
    );

    // Waiting still satisfies the current turn's check: no reminder follows.
    const dispatchPrompt = harness.agents[B].prompts[0];
    dispatchPrompt.resolve();
    harness.endTurn(childId, dispatchPrompt.promptId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      harness.agents[B].prompts.length,
      1,
      "a turn that reported waiting needs no closing reminder",
    );
    assert.equal(
      harness.store.getTask(childId)?.workflow_status,
      "waiting",
      "a turn end must not overwrite waiting",
    );
  });
});
