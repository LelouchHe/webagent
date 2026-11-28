import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("contract-08 browser DOM reconciliation (F6, F7, F9, F10)", () => {
  let state: typeof import("../public/js/state.ts").state;
  let dom: typeof import("../public/js/state.ts").dom;
  let events: typeof import("../public/js/events.ts");
  let persisted: typeof import("../public/js/persisted-event.ts");

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    events = await import("../public/js/events.ts");
    persisted = await import("../public/js/persisted-event.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    persisted.previewReconciler.reset();
    state.taskId = "t1";
    state.lastEventSeq = 0;
  });

  it("F6: seals provisional idle preview in-place ABOVE optimistic user bubble without duplicating", () => {
    // 1. Agent streams an idle preview chunk with (epoch, segmentId=1).
    events.handleEvent({
      type: "message_chunk",
      taskId: "t1",
      text: "partial tail",
      epoch: "ep-1",
      segmentId: 1,
      offset: 0,
      endOffset: 12,
    });
    assert.ok(state.currentAssistantEl);
    // 2. User submits a new prompt: marks provisional preview and mounts optimistic user bubble below it.
    state.currentAssistantEl.dataset.previewProvisional = "1";
    const userBubble = document.createElement("div");
    userBubble.className = "msg user";
    userBubble.textContent = "follow up";
    userBubble.dataset.optimisticOpId = "op-2";
    dom.messages.appendChild(userBubble);
    state.currentAssistantEl = null;

    // 3. Server /prompt flushes segment 1 as persisted assistant_message BEFORE user_message.
    events.applyPersistedEvent({
      feed: "t1",
      pos: 1,
      prev: 0,
      data: {
        id: 1,
        task_id: "t1",
        seq: 1,
        type: "assistant_message",
        data: JSON.stringify({
          text: "partial tail complete",
          epoch: "ep-1",
          segmentId: 1,
        }),
        from_ref: "agent",
        created_at: new Date().toISOString(),
      },
    });

    const assistants = dom.messages.querySelectorAll(".msg.assistant");
    assert.equal(assistants.length, 1, "must not duplicate assistant bubble");
    const children = [...dom.messages.children];
    assert.ok(
      children.indexOf(assistants[0]) < children.indexOf(userBubble),
      "flushed assistant must stay above optimistic user bubble",
    );
  });

  it("F7: completes a bash block across disconnect when bash_result arrives on recovery", () => {
    events.applyPersistedEvent({
      feed: "t1",
      pos: 1,
      prev: 0,
      data: {
        id: 1,
        task_id: "t1",
        seq: 1,
        type: "bash_command",
        data: JSON.stringify({ command: "echo hi" }),
        from_ref: "user",
        created_at: new Date().toISOString(),
      },
    });
    assert.ok(state.currentBashEl, "bash block mounted");

    // Simulate disconnect marking the live bash stream incomplete without destroying the host.
    state.currentBashEl.dataset.bashDisconnected = "1";

    // Recovery delivers canonical bash_result.
    events.applyPersistedEvent({
      feed: "t1",
      pos: 2,
      prev: 1,
      data: {
        id: 2,
        task_id: "t1",
        seq: 2,
        type: "bash_result",
        data: JSON.stringify({ output: "hi\n", code: 0, signal: null }),
        from_ref: "system",
        created_at: new Date().toISOString(),
      },
    });

    assert.equal(state.currentBashEl, null, "bash block sealed");
    assert.match(dom.messages.textContent, /hi/);
    assert.equal(state.lastEventSeq, 2);
  });

  it("F9: applies snapshot pendingPermissions and skips covered state_patch without extra snapshot GET", async () => {
    let snapshotCalls = 0;
    const origFetch = globalThis.fetch;
    const permissionPosts: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/snapshot")) snapshotCalls += 1;
      if (String(url).includes("/permissions/") && init?.method === "POST") {
        permissionPosts.push({
          url: String(url),
          body: JSON.parse(
            typeof init.body === "string" ? init.body : "{}",
          ) as Record<string, unknown>,
        });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            version: 1,
            seq: 5,
            task: { id: "t1", cwd: "/tmp", lastEventSeq: 0 },
            runtime: { busy: null },
          }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const { applySnapshot } = await import("../public/js/state.ts");
      applySnapshot({
        version: 1,
        seq: 5,
        task: {
          id: "t1",
          title: null,
          cwd: "/tmp",
          model: null,
          mode: null,
          createdAt: null,
          lastEventSeq: 0,
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "m2",
            options: [{ value: "m2", name: "Model 2" }],
          },
        ],
        runtime: {
          busy: null,
          pendingPermissions: [
            {
              requestId: "perm-snap-1",
              title: "Allow tool?",
              options: [
                { optionId: "allow_once", label: "Allow", kind: "allow_once" },
                { optionId: "reject_once", label: "Deny", kind: "reject_once" },
              ],
            },
          ],
        },
      });
      assert.equal(
        state.configOptions.find((o) => o.id === "model")?.currentValue,
        "m2",
        "recovery snapshot delivers configOptions even if warm arrived before route",
      );
      assert.ok(
        dom.messages.querySelector(
          '.permission[data-request-id="perm-snap-1"]',
        ),
        "pending permission from snapshot must be rendered",
      );

      // Covered state_patch (seq 4 <= lastStateSeq 5) must be skipped with 0 snapshot GETs.
      events.handleEvent({
        type: "state_patch",
        taskId: "t1",
        seq: 4,
        patch: { runtime: { busy: null } },
      } as any);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(snapshotCalls, 0);

      // R5 + R3-4: reconstructed permission card has labeled buttons and clicking
      // the deny button (kind: reject_once) sends denied: true.
      const permCard = dom.messages.querySelector(
        '.permission[data-request-id="perm-snap-1"]',
      );
      const permButtons = Array.from(
        permCard?.querySelectorAll("button") ?? [],
      );
      assert.deepEqual(
        permButtons.map((b) => b.textContent),
        ["Allow", "Deny"],
      );
      permButtons[1]?.click();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(permissionPosts.length, 1);
      assert.equal(permissionPosts[0].body.denied, true);

      // R2 + R5: untrusted HTML in permission title stays literal text when settled across disconnect
      // even after state.pendingPermissionRequestIds was cleared!
      const xssCard = document.createElement("div");
      xssCard.className = "permission";
      xssCard.dataset.requestId = "perm-xss";
      const titleEl = document.createElement("div");
      titleEl.className = "title";
      titleEl.textContent = '<img src=x onerror="window.__xss=1">';
      const btn = document.createElement("button");
      btn.textContent = "Allow";
      xssCard.append(titleEl, btn);
      dom.messages.appendChild(xssCard);
      state.pendingPermissionRequestIds.clear();

      applySnapshot({
        version: 1,
        seq: 6,
        task: {
          id: "t1",
          title: null,
          cwd: "/tmp",
          model: null,
          mode: null,
          createdAt: null,
          lastEventSeq: 0,
        },
        runtime: { busy: null, pendingPermissions: [] },
      });
      assert.equal(xssCard.querySelector("img"), null, "must not parse HTML");
      assert.equal(
        xssCard.querySelector("button"),
        null,
        "settled card removes button",
      );
      assert.match(
        xssCard.textContent,
        /<img src=x onerror="window\.__xss=1"> — resolved/,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("R7: persisted apply renders directly while replayInProgress without enqueuing into replayQueue", () => {
    state.replayInProgress = true;
    state.replayQueue = [];
    try {
      events.applyPersistedEvent({
        feed: "t1",
        pos: 1,
        prev: 0,
        data: {
          id: 1,
          task_id: "t1",
          seq: 1,
          type: "user_message",
          data: JSON.stringify({ text: "positioned during replay" }),
          from_ref: "user",
          created_at: new Date().toISOString(),
        },
      });
      assert.equal(state.replayQueue.length, 0);
      assert.equal(state.lastEventSeq, 1);
      assert.match(dom.messages.textContent, /positioned during replay/);
    } finally {
      state.replayInProgress = false;
    }
  });

  it("R3-5: adopting optimistic user bubble moves it after an earlier persisted tail without preview DOM", () => {
    const userEl = document.createElement("div");
    userEl.className = "msg user";
    userEl.dataset.optimisticOpId = "op-order-1";
    userEl.textContent = "follow-up prompt";
    dom.messages.appendChild(userEl);

    // Persisted assistant tail (seq 1) arrives with NO preview DOM in the page.
    events.applyPersistedEvent({
      feed: "t1",
      pos: 1,
      prev: 0,
      data: {
        id: 1,
        task_id: "t1",
        seq: 1,
        type: "assistant_message",
        data: JSON.stringify({ text: "prior tail without preview" }),
        from_ref: "agent",
        created_at: new Date().toISOString(),
      },
    });
    // Optimistic successor's echo (seq 2) adopts the user bubble.
    events.applyPersistedEvent({
      feed: "t1",
      pos: 2,
      prev: 1,
      data: {
        id: 2,
        task_id: "t1",
        seq: 2,
        type: "user_message",
        data: JSON.stringify({
          text: "follow-up prompt",
          clientOpId: "op-order-1",
        }),
        from_ref: "user",
        created_at: new Date().toISOString(),
      },
    });

    const msgs = Array.from(dom.messages.querySelectorAll(".msg"));
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].classList.contains("assistant"));
    assert.ok(msgs[1].classList.contains("user"));
    assert.equal(msgs[1].getAttribute("data-optimistic-op-id"), null);
  });

  it("R3-6: handleHubControlEvent delegates task_title_updated/task_deleted once without duplicate pre-observation", () => {
    let forwarded = 0;
    persisted.handleHubControlEvent(
      { type: "task_title_updated", taskId: "t1", title: "Renamed" },
      () => {
        forwarded += 1;
      },
    );
    persisted.handleHubControlEvent(
      { type: "task_deleted", taskId: "t2" },
      () => {
        forwarded += 1;
      },
    );
    assert.equal(forwarded, 2);
  });

  it("F10: does not advance state.lastEventSeq when JSON is malformed or sink throws", () => {
    assert.throws(() => {
      events.applyPersistedEvent({
        feed: "t1",
        pos: 1,
        prev: 0,
        data: {
          id: 1,
          task_id: "t1",
          seq: 1,
          type: "user_message",
          data: "{not-valid-json",
          from_ref: "user",
          created_at: new Date().toISOString(),
        },
      });
    });
    assert.equal(state.lastEventSeq, 0);

    assert.throws(() => {
      persisted.applyPersistedEventImpl(
        {
          feed: "t1",
          pos: 1,
          prev: 0,
          data: {
            id: 1,
            task_id: "t1",
            seq: 1,
            type: "tool_call",
            data: JSON.stringify({ id: "tc-1", title: "boom" }),
            from_ref: "agent",
            created_at: new Date().toISOString(),
          },
        },
        {
          liveHooks: () => ({}) as any,
          scheduleAssistantRender: () => {},
          promptStopNotice: () => null,
          handleEvent: () => {
            throw new Error("sink boom");
          },
        },
      );
    }, /sink boom/);
    assert.equal(state.lastEventSeq, 0);
  });
});
