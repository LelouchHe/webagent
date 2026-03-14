import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TitleService } from "../src/title-service.ts";

describe("TitleService", () => {
  it("creates a silent title session, cleans the title, and caches the session", async () => {
    const titleUpdates: Array<{ sessionId: string; title: string }> = [];
    const store = {
      updateSessionTitle(sessionId: string, title: string) {
        titleUpdates.push({ sessionId, title });
      },
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const bridgeCalls = {
      newSession: [] as any[],
      setConfigOption: [] as any[],
      promptForText: [] as any[],
    };
    const bridge = {
      async newSession(cwd: string, opts: any) {
        bridgeCalls.newSession.push({ cwd, opts });
        return "title-session";
      },
      async setConfigOption(sessionId: string, configId: string, value: string) {
        bridgeCalls.setConfigOption.push({ sessionId, configId, value });
      },
      async promptForText(sessionId: string, prompt: string) {
        bridgeCalls.promptForText.push({ sessionId, prompt });
        return `"  A very useful title that is definitely too long  "`;
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo");

    const title = await (service as any)._generate(bridge, "hello world", "session-1");

    assert.equal(title, "A very useful title that is de");
    assert.deepEqual(titleUpdates, [{ sessionId: "session-1", title: "A very useful title that is de" }]);
    assert.ok(sessions.sessionHasTitle.has("session-1"));
    assert.ok(sessions.liveSessions.has("title-session"));
    assert.deepEqual(bridgeCalls.newSession, [{ cwd: "/repo", opts: { silent: true } }]);
    assert.deepEqual(bridgeCalls.setConfigOption, [{
      sessionId: "title-session",
      configId: "model",
      value: "claude-haiku-4.5",
    }]);

    await (service as any)._generate(bridge, "another message", "session-2");
    assert.equal(bridgeCalls.newSession.length, 1);
  });

  it("swallows title-session setup failure and returns nothing", async () => {
    const store = { updateSessionTitle() { throw new Error("should not be called"); } };
    const sessions = { sessionHasTitle: new Set<string>(), liveSessions: new Set<string>() };
    const bridge = {
      async newSession() {
        throw new Error("bridge unavailable");
      },
      async setConfigOption() {},
      async promptForText() {
        throw new Error("should not be called");
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo");

    const title = await (service as any)._generate(bridge, "hello", "session-1");

    assert.equal(title, undefined);
    assert.equal(sessions.sessionHasTitle.size, 0);
  });

  it("generate calls the callback only when a title is produced", async () => {
    const store = { updateSessionTitle() {} };
    const sessions = { sessionHasTitle: new Set<string>(), liveSessions: new Set<string>() };
    const bridge = {
      async newSession() { return "title-session"; },
      async setConfigOption() {},
      async promptForText() { return "Generated"; },
    };
    const service = new TitleService(store as any, sessions as any, "/repo");
    const titles: string[] = [];

    service.generate(bridge as any, "hello", "session-1", (title) => titles.push(title));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(titles, ["Generated"]);
  });

  it("cancels title generation only for the matching source session", async () => {
    const store = { updateSessionTitle() {} };
    const sessions = { sessionHasTitle: new Set<string>(), liveSessions: new Set<string>() };
    const cancelCalls: string[] = [];
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() { return "title-session"; },
      async setConfigOption() {},
      async promptForText() {
        return await new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
      async cancel(sessionId: string) {
        cancelCalls.push(sessionId);
        releasePrompt?.("");
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo");

    service.generate(bridge as any, "hello", "session-1");
    await new Promise((resolve) => setImmediate(resolve));
    service.cancel("session-2", bridge as any);
    service.cancel("session-1", bridge as any);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(cancelCalls, ["title-session"]);
  });

  it("deduplicates in-flight title generation and allows retry after cancellation", async () => {
    const store = { updateSessionTitle() { throw new Error("should not be called"); } };
    const sessions = { sessionHasTitle: new Set<string>(), liveSessions: new Set<string>() };
    const promptCalls: string[] = [];
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() { return "title-session"; },
      async setConfigOption() {},
      async promptForText() {
        promptCalls.push("prompt");
        return await new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
      async cancel() {
        releasePrompt?.("");
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo");

    service.generate(bridge as any, "hello", "session-1");
    await new Promise((resolve) => setImmediate(resolve));
    service.generate(bridge as any, "hello again", "session-1");
    await new Promise((resolve) => setImmediate(resolve));
    await service.cancel("session-1", bridge as any);
    await new Promise((resolve) => setImmediate(resolve));
    service.generate(bridge as any, "third try", "session-1");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(promptCalls, ["prompt", "prompt"]);
    assert.equal(sessions.sessionHasTitle.has("session-1"), false);
  });

  it("skips overwriting when user sets title while generation is in flight", async () => {
    const titleUpdates: Array<{ sessionId: string; title: string }> = [];
    const store = {
      updateSessionTitle(sessionId: string, title: string) {
        titleUpdates.push({ sessionId, title });
      },
    };
    const sessions = { sessionHasTitle: new Set<string>(), liveSessions: new Set<string>() };
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() { return "title-session"; },
      async setConfigOption() {},
      async promptForText() {
        return await new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo");

    // Start generation
    const titles: string[] = [];
    service.generate(bridge as any, "hello", "session-1", (t) => titles.push(t));
    await new Promise((resolve) => setImmediate(resolve));

    // User manually sets title while generation is in flight
    sessions.sessionHasTitle.add("session-1");

    // Now release the prompt with a generated title
    releasePrompt?.("Auto Title");
    await new Promise((resolve) => setImmediate(resolve));

    // The auto-generated title should NOT have been stored
    assert.deepEqual(titleUpdates, []);
    assert.deepEqual(titles, []);
  });
});
