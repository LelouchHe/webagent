import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TitleService } from "../src/title-service.ts";

describe("TitleService", () => {
  it("creates a silent title task, cleans the title, and caches the task", async () => {
    const titleUpdates: Array<{ taskId: string; title: string }> = [];
    const internalTasks: string[] = [];
    const store = {
      registerInternalAgentSession(taskId: string) {
        internalTasks.push(taskId);
      },
      updateTaskTitle(taskId: string, title: string) {
        titleUpdates.push({ taskId, title });
      },
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
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
          sessionId: "title-task",
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
        taskId: string,
        configId: string,
        value: string,
      ) {
        bridgeCalls.setAgentConfigOption.push({
          sessionId: taskId,
          configId,
          value,
        });
      },
      async promptForText(taskId: string, prompt: string) {
        bridgeCalls.promptForText.push({ sessionId: taskId, prompt });
        return `"  A very useful title that is definitely too long  "`;
      },
    };
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    const title = await (service as any)._generate(
      bridge,
      "hello world",
      "task-1",
    );

    assert.equal(title, "A very useful title that is de");
    assert.deepEqual(titleUpdates, [
      { taskId: "task-1", title: "A very useful title that is de" },
    ]);
    assert.ok(tasks.taskHasTitle.has("task-1"));
    assert.deepEqual(internalTasks, ["title-task"]);
    assert.ok(!tasks.liveTasks.has("title-task"));
    assert.deepEqual(bridgeCalls.newSession, [
      { cwd: "/repo", opts: { silent: true } },
    ]);
    assert.deepEqual(bridgeCalls.setAgentConfigOption, [
      {
        sessionId: "title-task",
        configId: "model",
        value: "claude-haiku-4.5",
      },
    ]);

    await (service as any)._generate(bridge, "another message", "task-2");
    assert.equal(bridgeCalls.newSession.length, 1);
  });

  it("skips setAgentConfigOption when modelPatterns is empty (inherit currentModelId)", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {},
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
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
          sessionId: "title-task",
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
      async setAgentConfigOption(taskId: string, configId: string) {
        bridgeCalls.setAgentConfigOption.push({ sessionId: taskId, configId });
        return [];
      },
      async promptForText() {
        return `"hi"`;
      },
    };
    // Empty patterns = skip setAgentConfigOption (inherit agent's currentModelId).
    const service = new TitleService(store as any, tasks as any, "/repo", []);

    await (service as any)._generate(bridge, "hello", "task-1");

    assert.deepEqual(
      bridgeCalls.setAgentConfigOption,
      [],
      "should not call setAgentConfigOption when modelPatterns is empty",
    );
  });

  it("picks first matching model by case-insensitive substring (cheap-tier preference)", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {},
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
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
          sessionId: "title-task",
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
        taskId: string,
        configId: string,
        value: string,
      ) {
        bridgeCalls.setAgentConfigOption.push({
          sessionId: taskId,
          configId,
          value,
        });
        return [];
      },
      async promptForText() {
        return `"hi"`;
      },
    };
    // Default pattern list (cheap-tier suffixes).
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "haiku",
      "flash-lite",
      "nano",
      "mini",
      "flash",
      "lite",
    ]);

    await (service as any)._generate(bridge, "hello", "task-1");

    // "mini" matches "GPT-5.4-Mini" (case-insensitive). "haiku"/"flash-lite"/
    // "nano" come earlier in the pattern list but don't match any option, so
    // we walk down to "mini".
    assert.deepEqual(bridgeCalls.setAgentConfigOption, [
      {
        sessionId: "title-task",
        configId: "model",
        value: "GPT-5.4-Mini",
      },
    ]);
  });

  it("falls back to currentModelId (no setAgentConfigOption) when no pattern matches", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {},
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
    };
    const bridgeCalls = {
      setAgentConfigOption: [] as any[],
    };
    const bridge = {
      async newSession() {
        return {
          sessionId: "title-task",
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
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "haiku",
      "mini",
      "flash",
    ]);

    await (service as any)._generate(bridge, "hello", "task-1");

    assert.deepEqual(bridgeCalls.setAgentConfigOption, []);
  });

  it("swallows title-task setup failure and returns nothing", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {
        throw new Error("should not be called");
      },
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
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
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    const title = await (service as any)._generate(bridge, "hello", "task-1");

    assert.equal(title, undefined);
    assert.equal(tasks.taskHasTitle.size, 0);
  });

  it("generate calls the callback only when a title is produced", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {},
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
    };
    const bridge = {
      async newSession() {
        return { sessionId: "title-task", configOptions: [] };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return "Generated";
      },
    };
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "claude-haiku-4.5",
    ]);
    const titles: string[] = [];

    service.generate(bridge as any, "hello", "task-1", (title) =>
      titles.push(title),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(titles, ["Generated"]);
  });

  it("cancels title generation only for the matching source task", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {},
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
    };
    const cancelCalls: string[] = [];
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() {
        return { sessionId: "title-task", configOptions: [] };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
      async cancelAgentSession(taskId: string) {
        cancelCalls.push(taskId);
        releasePrompt?.("");
      },
    };
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    service.generate(bridge as any, "hello", "task-1");
    await new Promise((resolve) => setImmediate(resolve));
    service.cancel("task-2", bridge as any);
    service.cancel("task-1", bridge as any);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(cancelCalls, ["title-task"]);
  });

  it("deduplicates in-flight title generation and allows retry after cancellation", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {
        throw new Error("should not be called");
      },
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
    };
    const promptCalls: string[] = [];
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() {
        return { sessionId: "title-task", configOptions: [] };
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
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    service.generate(bridge as any, "hello", "task-1");
    await new Promise((resolve) => setImmediate(resolve));
    service.generate(bridge as any, "hello again", "task-1");
    await new Promise((resolve) => setImmediate(resolve));
    await service.cancel("task-1", bridge as any);
    await new Promise((resolve) => setImmediate(resolve));
    service.generate(bridge as any, "third try", "task-1");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(promptCalls, ["prompt", "prompt"]);
    assert.equal(tasks.taskHasTitle.has("task-1"), false);
  });

  it("skips overwriting when user sets title while generation is in flight", async () => {
    const titleUpdates: Array<{ taskId: string; title: string }> = [];
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle(taskId: string, title: string) {
        titleUpdates.push({ taskId, title });
      },
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
    };
    let releasePrompt: ((value: string) => void) | null = null;
    const bridge = {
      async newSession() {
        return { sessionId: "title-task", configOptions: [] };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return new Promise<string>((resolve) => {
          releasePrompt = resolve;
        });
      },
    };
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    // Start generation
    const titles: string[] = [];
    service.generate(bridge as any, "hello", "task-1", (t) => titles.push(t));
    await new Promise((resolve) => setImmediate(resolve));

    // User manually sets title while generation is in flight
    tasks.taskHasTitle.add("task-1");

    // Now release the prompt with a generated title
    releasePrompt!("Auto Title");
    await new Promise((resolve) => setImmediate(resolve));

    // The auto-generated title should NOT have been stored
    assert.deepEqual(titleUpdates, []);
    assert.deepEqual(titles, []);
  });

  it("invalidate() clears the cached title task so next generate creates a new one", async () => {
    const store = {
      registerInternalAgentSession() {},
      updateTaskTitle() {},
    };
    const tasks = {
      taskHasTitle: new Set<string>(),
      liveTasks: new Set<string>(),
    };
    let newTaskCalls = 0;
    const bridge = {
      async newSession() {
        newTaskCalls++;
        return {
          sessionId: `title-task-${newTaskCalls}`,
          configOptions: [],
        };
      },
      async setAgentConfigOption() {},
      async promptForText() {
        return "Title";
      },
    };
    const service = new TitleService(store as any, tasks as any, "/repo", [
      "claude-haiku-4.5",
    ]);

    // First generation creates a title task
    await (service as any)._generate(bridge, "hello", "task-1");
    assert.equal(newTaskCalls, 1);

    // Second generation reuses the cached task
    tasks.taskHasTitle.clear(); // allow re-generation
    await (service as any)._generate(bridge, "hello", "task-2");
    assert.equal(newTaskCalls, 1, "should reuse cached task");

    // After invalidate(), next generation creates a new task
    service.invalidate();
    tasks.taskHasTitle.clear();
    await (service as any)._generate(bridge, "hello", "task-3");
    assert.equal(newTaskCalls, 2, "should create new task after invalidate");
  });
});
