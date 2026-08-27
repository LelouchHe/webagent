import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TitleService } from "../src/title-service.ts";

describe("TitleService", () => {
  it("creates a silent title session, cleans the title, and caches the session", async () => {
    const titleUpdates: Array<{ sessionId: string; title: string }> = [];
    const internalSessions: string[] = [];
    const store = {
      registerInternalAgentSession(sessionId: string) {
        internalSessions.push(sessionId);
      },
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
      setAgentConfigOption: [] as any[],
      promptForText: [] as any[],
    };
    const bridge = {
      async newSession(cwd: string, opts: any) {
        bridgeCalls.newSession.push({ cwd, opts });
        return {
          sessionId: "title-session",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              currentValue: "claude-sonnet-4.5",
              options: [
                { value: "claude-sonnet-4.5", name: "Sonnet" },
                { value: "claude-haiku-4.5", name: "Haiku" },
              ],
            },
          ],
        };
      },
      async setAgentConfigOption(
        sessionId: string,
        configId: string,
        value: string,
      ) {
        bridgeCalls.setAgentConfigOption.push({ sessionId, configId, value });
      },
      async promptForText(sessionId: string, prompt: string) {
        bridgeCalls.promptForText.push({ sessionId, prompt });
        return `"  A very useful title that is definitely too long  "`;
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    const title = await (service as any)._generate(
      bridge,
      "hello world",
      "session-1",
    );

    assert.equal(title, "A very useful title that is de");
    assert.deepEqual(titleUpdates, [
      { sessionId: "session-1", title: "A very useful title that is de" },
    ]);
    assert.ok(sessions.sessionHasTitle.has("session-1"));
    assert.deepEqual(internalSessions, ["title-session"]);
    assert.ok(!sessions.liveSessions.has("title-session"));
    assert.deepEqual(bridgeCalls.newSession, [
      { cwd: "/repo", opts: { silent: true } },
    ]);
    assert.deepEqual(bridgeCalls.setAgentConfigOption, [
      {
        sessionId: "title-session",
        configId: "model",
        value: "claude-haiku-4.5",
      },
    ]);

    await (service as any)._generate(bridge, "another message", "session-2");
    assert.equal(bridgeCalls.newSession.length, 1);
  });

  it("skips setAgentConfigOption when modelPatterns is empty (inherit currentModelId)", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {},
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const bridgeCalls = {
      setAgentConfigOption: [] as Array<{
        sessionId: string;
        configId: string;
      }>,
    };
    const bridge = {
      async newSession() {
        return {
          sessionId: "title-session",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              currentValue: "gpt-5",
              options: [{ value: "gpt-5", name: "GPT-5" }],
            },
          ],
        };
      },
      async setAgentConfigOption(sessionId: string, configId: string) {
        bridgeCalls.setAgentConfigOption.push({ sessionId, configId });
        return [];
      },
      async promptForText() {
        return `"hi"`;
      },
    };
    // Empty patterns = skip setAgentConfigOption (inherit agent's currentModelId).
    const service = new TitleService(
      store as any,
      sessions as any,
      "/repo",
      [],
    );

    await (service as any)._generate(bridge, "hello", "session-1");

    assert.deepEqual(
      bridgeCalls.setAgentConfigOption,
      [],
      "should not call setAgentConfigOption when modelPatterns is empty",
    );
  });

  it("picks first matching model by case-insensitive substring (cheap-tier preference)", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {},
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const bridgeCalls = {
      setAgentConfigOption: [] as Array<{
        sessionId: string;
        configId: string;
        value: string;
      }>,
    };
    const bridge = {
      async newSession() {
        // Codex+litellm style: capitalized id, "Mini" suffix means cheap.
        return {
          sessionId: "title-session",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              currentValue: "GPT-5.5",
              options: [
                { value: "GPT-5.5", name: "GPT-5.5" },
                { value: "gpt-5.4", name: "gpt-5.4" },
                { value: "GPT-5.4-Mini", name: "GPT-5.4-Mini" },
                { value: "gpt-5.3-codex", name: "gpt-5.3-codex" },
              ],
            },
          ],
        };
      },
      async setAgentConfigOption(
        sessionId: string,
        configId: string,
        value: string,
      ) {
        bridgeCalls.setAgentConfigOption.push({ sessionId, configId, value });
        return [];
      },
      async promptForText() {
        return `"hi"`;
      },
    };
    // Default pattern list (cheap-tier suffixes).
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "haiku",
      "flash-lite",
      "nano",
      "mini",
      "flash",
      "lite",
    ]);

    await (service as any)._generate(bridge, "hello", "session-1");

    // "mini" matches "GPT-5.4-Mini" (case-insensitive). "haiku"/"flash-lite"/
    // "nano" come earlier in the pattern list but don't match any option, so
    // we walk down to "mini".
    assert.deepEqual(bridgeCalls.setAgentConfigOption, [
      {
        sessionId: "title-session",
        configId: "model",
        value: "GPT-5.4-Mini",
      },
    ]);
  });

  it("falls back to currentModelId (no setAgentConfigOption) when no pattern matches", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {},
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const bridgeCalls = {
      setAgentConfigOption: [] as any[],
    };
    const bridge = {
      async newSession() {
        return {
          sessionId: "title-session",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              currentValue: "custom-model-1",
              options: [
                { value: "custom-model-1", name: "C1" },
                { value: "custom-model-2", name: "C2" },
              ],
            },
          ],
        };
      },
      async setAgentConfigOption(...args: any[]) {
        bridgeCalls.setAgentConfigOption.push(args);
        return [];
      },
      async promptForText() {
        return `"hi"`;
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "haiku",
      "mini",
      "flash",
    ]);

    await (service as any)._generate(bridge, "hello", "session-1");

    assert.deepEqual(bridgeCalls.setAgentConfigOption, []);
  });

  it("swallows title-session setup failure and returns nothing", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {
        throw new Error("should not be called");
      },
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const bridge = {
      async newSession() {
        throw new Error("bridge unavailable");
      },
      async setAgentConfigOption() {},
      async promptForText() {
        throw new Error("should not be called");
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    const title = await (service as any)._generate(
      bridge,
      "hello",
      "session-1",
    );

    assert.equal(title, undefined);
    assert.equal(sessions.sessionHasTitle.size, 0);
  });

  it("generate calls the callback only when a title is produced", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {},
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const bridge = {
      async newSession() {
        return { sessionId: "title-session", configOptions: [] };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return "Generated";
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "claude-haiku-4.5",
    ]);
    const titles: string[] = [];

    service.generate(bridge as any, "hello", "session-1", (title) =>
      titles.push(title),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(titles, ["Generated"]);
  });

  it("cancels title generation only for the matching source session", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {},
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const cancelCalls: string[] = [];
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() {
        return { sessionId: "title-session", configOptions: [] };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
      async cancelAgentSession(sessionId: string) {
        cancelCalls.push(sessionId);
        releasePrompt?.("");
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    service.generate(bridge as any, "hello", "session-1");
    await new Promise((resolve) => setImmediate(resolve));
    service.cancel("session-2", bridge as any);
    service.cancel("session-1", bridge as any);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(cancelCalls, ["title-session"]);
  });

  it("deduplicates in-flight title generation and allows retry after cancellation", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {
        throw new Error("should not be called");
      },
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    const promptCalls: string[] = [];
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() {
        return { sessionId: "title-session", configOptions: [] };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        promptCalls.push("prompt");
        return new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
      async cancelAgentSession() {
        releasePrompt?.("");
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "claude-haiku-4.5",
    ]);

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
      registerInternalAgentSession() {},
      updateSessionTitle(sessionId: string, title: string) {
        titleUpdates.push({ sessionId, title });
      },
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() {
        return { sessionId: "title-session", configOptions: [] };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    // Start generation
    const titles: string[] = [];
    service.generate(bridge as any, "hello", "session-1", (t) =>
      titles.push(t),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // User manually sets title while generation is in flight
    sessions.sessionHasTitle.add("session-1");

    // Now release the prompt with a generated title
    releasePrompt!("Auto Title");
    await new Promise((resolve) => setImmediate(resolve));

    // The auto-generated title should NOT have been stored
    assert.deepEqual(titleUpdates, []);
    assert.deepEqual(titles, []);
  });

  it("invalidate() clears the cached title session so next generate creates a new one", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateSessionTitle() {},
    };
    const sessions = {
      sessionHasTitle: new Set<string>(),
      liveSessions: new Set<string>(),
    };
    let newSessionCalls = 0;
    const bridge = {
      async newSession() {
        newSessionCalls++;
        return {
          sessionId: `title-session-${newSessionCalls}`,
          configOptions: [],
        };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return "Title";
      },
    };
    const service = new TitleService(store as any, sessions as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    // First generation creates a title session
    await (service as any)._generate(bridge, "hello", "session-1");
    assert.equal(newSessionCalls, 1);

    // Second generation reuses the cached session
    sessions.sessionHasTitle.clear(); // allow re-generation
    await (service as any)._generate(bridge, "hello", "session-2");
    assert.equal(newSessionCalls, 1, "should reuse cached session");

    // After invalidate(), next generation creates a new session
    service.invalidate();
    sessions.sessionHasTitle.clear();
    await (service as any)._generate(bridge, "hello", "session-3");
    assert.equal(
      newSessionCalls,
      2,
      "should create new session after invalidate",
    );
  });
});
