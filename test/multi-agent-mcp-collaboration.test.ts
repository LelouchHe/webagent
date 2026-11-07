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
  toolErrorText,
  toolResult,
  waitForPrompts,
  type Harness,
} from "./fixtures/mcp-multi-agent-harness.ts";

/**
 * The cross-agent collaboration loop, not just the creation call.
 *
 * A parent on A dispatches to a child on B through the real MCP tools; the
 * child really receives its first turn on B's transport, its typed account
 * wakes the parent on A, and the reminder / terminal-notice legs are routed by
 * the target's own binding rather than by the default agent.
 *
 * Each case reads the transports' prompt arrays: "the child was asked" is a
 * fact about B's transport, and "the parent was woken" is a fact about A's.
 */

const A = AGENT_A;
const B = AGENT_B;

function pendingRetries(harness: Harness): Map<string, string[]> {
  return (
    harness.tasks as unknown as {
      pendingDispatchRetries: Map<string, string[]>;
    }
  ).pendingDispatchRetries;
}

function childUpdateEvents(
  harness: Harness,
  taskId: string,
): Array<{ status?: unknown; body?: unknown }> {
  return harness.store
    .getEvents(taskId)
    .filter((event) => event.type === "task_update")
    .map(
      (event) => JSON.parse(event.data) as { status?: unknown; body?: unknown },
    );
}

describe("cross-agent collaboration", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  /**
   * Parent on A, child created on B through the real tool, dispatch sent.
   * Returns the ids/tokens plus the armed obligation.
   */
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

    // One dispatch message, one production observer call, one record.
    const obligation = harness.tasks.getObligation(parent.taskId, childId);
    assert.ok(obligation, "the dispatch must arm exactly one obligation");
    assert.equal(harness.observerFacts.length, 1);
    assert.equal(
      harness.observerFacts[0].messageId,
      obligation.openingMessageId,
      "the observer saw the dispatch message itself",
    );
    // Hand-off owes the closing reminder immediately; the live dispatch turn
    // is what keeps it from being submitted yet.
    assert.equal(
      harness.tasks.getObligation(parent.taskId, childId)?.state,
      "reminder_due",
    );
    return { parentId: parent.taskId, childId, childToken };
  }

  it("wakes the parent on A with the child's account from B", async () => {
    const { parentId, childId, childToken } = await dispatchToChildOnB();

    // The dispatch turn on B is live, so the update is eligible to settle.
    const turn = harness.tasks.getActiveAgentTurn(childId);
    assert.ok(turn, "the child's dispatch turn must be the active turn");

    const updated = await callTool(harness, childToken, "task_update", {
      status: "done",
      body: "finished the review",
    });
    assert.equal(toolResult(updated.json).isError, undefined);

    // The account settles the record and is persisted as the typed update.
    assert.equal(
      harness.tasks.getObligation(parentId, childId)?.state,
      "settled",
    );
    assert.equal(harness.store.getTask(childId)?.workflow_status, "done");
    const updates = childUpdateEvents(harness, childId);
    assert.equal(updates.length, 1, "the typed update is persisted once");
    assert.equal(updates[0].status, "done");
    assert.equal(updates[0].body, "finished the review");
    assert.equal(pendingRetries(harness).has(childId), false);

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

  it("routes the closing reminder to B and the terminal notice to A", async () => {
    const { parentId, childId } = await dispatchToChildOnB();

    // The dispatch turn ends without an account: a reminder is owed.
    const dispatchPrompt = harness.agents[B].prompts[0];
    dispatchPrompt.resolve();
    harness.endTurn(childId, dispatchPrompt.promptId);

    await waitForPrompts(harness, B, 2);
    const reminder = harness.agents[B].prompts[1];
    assert.equal(reminder.taskId, childId);
    assert.match(
      reminder.text,
      /runtime-injected closing turn/i,
      "the closing reminder goes to the target's own transport",
    );
    assert.equal(
      harness.agents[A].prompts.length,
      0,
      "the reminder must not be delivered to the source's transport",
    );

    // Reject the reminder submissions until the transport budget is spent. The
    // controller's backoff is 1s then 2s.
    reminder.reject(new Error("down"));
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await waitForPrompts(harness, B, 3);
    harness.agents[B].prompts[2].reject(new Error("down"));
    await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
    await waitForPrompts(harness, B, 4);
    harness.agents[B].prompts[3].reject(new Error("down"));

    // The terminal notice is a collaboration message from the child; it is
    // delivered to the stored source's own transport (A).
    await waitForPrompts(harness, A, 1, "the terminal notice never reached A");
    const notice = harness.agents[A].prompts[0].text;
    assert.match(notice, /^reason: delivery_failed$/m);
    assert.match(notice, /^message: .*could not deliver/m);
    assert.match(notice, /^openingMessageId: \S+$/m);
    assert.equal(notice.includes('{"'), false, "the notice is prose, not JSON");
    assert.equal(
      harness.agents[B].prompts.length,
      4,
      "the notice must not be delivered to the target's own transport",
    );

    // The machine payload is still the notice event on the producing task.
    const noticeEvent = harness.store
      .getEvents(childId)
      .filter((event) => event.type === "task_outcome_notice")
      .at(-1);
    assert.ok(noticeEvent, "the machine payload must be persisted");
    const payload = JSON.parse(noticeEvent.data) as Record<string, unknown>;
    assert.equal(payload.reason, "delivery_failed");
    assert.equal(
      (payload.evidence as Record<string, unknown>).deliveryUnavailable,
      true,
    );
    assert.ok(notice.includes(String(payload.openingMessageId)));
    const obligation = harness.tasks.getObligation(parentId, childId);
    assert.equal(obligation?.state, "unresolved");
  });

  it("refuses a once-valid old execution's account on the replacement's turn", async () => {
    const { parentId, childId, childToken } = await dispatchToChildOnB();
    void childToken;

    // The dispatch turn ends, then the child's execution is replaced: the new
    // session's closing reminder opens the replacement's active turn.
    const dispatchPrompt = harness.agents[B].prompts[0];
    const oldGeneration = harness.tasks.authority.leaseFor(childId)?.generation;
    assert.ok(oldGeneration !== undefined);
    dispatchPrompt.resolve();
    harness.endTurn(childId, dispatchPrompt.promptId);
    await harness.tasks.clearTask(
      harness.agents[B].bridge,
      childId,
      undefined,
      { reason: "explicit_clear" },
    );
    await waitForPrompts(harness, B, 2);
    const currentGeneration =
      harness.tasks.authority.leaseFor(childId)?.generation;
    assert.ok(typeof currentGeneration === "number");
    assert.ok(
      currentGeneration > oldGeneration,
      "the replacement must have advanced the generation",
    );
    const turn = harness.tasks.getActiveAgentTurn(childId);
    assert.ok(turn, "the replacement must own a live, settleable turn");

    const before = harness.tasks.getObligation(parentId, childId);
    assert.ok(before);
    const attemptsBefore = before.deliveredAttempts;
    const eventsBefore = childUpdateEvents(harness, childId).length;
    const factsBefore = harness.observerFacts.length;

    // A token minted for the generation that *was* current a moment ago. It is
    // a real capability (it resolves, so the entry gate admits it); only the
    // authority check can refuse it.
    const staleToken = harness.capabilities.mint(childId, B, oldGeneration);
    assert.ok(harness.capabilities.resolve(staleToken));
    const refused = await callMcpTool(harness, staleToken, "task_update", {
      status: "done",
      body: "stale account",
    });
    assert.equal(refused.status, 200, "the tool call itself is answered");
    assert.equal(toolResult(refused.json).isError, true);
    assert.match(toolErrorText(refused.json), /execution_replaced/);

    // Nothing was settled, spent, or re-enqueued.
    const after = harness.tasks.getObligation(parentId, childId);
    assert.ok(after);
    assert.notEqual(after.state, "settled");
    assert.equal(after.deliveredAttempts, attemptsBefore);
    assert.equal(after.openingMessageId, before.openingMessageId);
    assert.equal(childUpdateEvents(harness, childId).length, eventsBefore);
    assert.equal(harness.observerFacts.length, factsBefore);
    assert.equal(pendingRetries(harness).has(childId), false);

    // Control: the current generation's token settles the same turn, so the
    // refusal was the fence, not a broken update path.
    const freshToken = harness.capabilities.mint(childId, B, currentGeneration);
    const accepted = await callMcpTool(harness, freshToken, "task_update", {
      status: "done",
      body: "fresh account",
    });
    assert.equal(toolResult(accepted.json).isError, undefined);
    assert.equal(
      harness.tasks.getObligation(parentId, childId)?.state,
      "settled",
    );
    assert.equal(
      childUpdateEvents(harness, childId).at(-1)?.body,
      "fresh account",
    );
    await waitForPrompts(harness, A, 1);
    assert.match(harness.agents[A].prompts[0].text, /fresh account/);
  });
});
