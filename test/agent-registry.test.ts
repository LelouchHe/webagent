import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "../src/agent-registry.ts";
import { AgentBridge } from "../src/bridge.ts";
import { Store } from "../src/store.ts";

/**
 * One agent, one process.
 *
 * The registry is the only thing that may start an agent, so it owns the
 * single-flight slot for both "start" and "reload". These tests use real child
 * processes whose `initialize` can be delayed or refused, because the failure
 * modes that matter here (a half-started bridge handed out, a leftover process
 * after a refused handshake, two processes during a reload) only exist with a
 * real lifecycle.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

interface Fixture {
  dir: string;
  callsPath: string;
  /** Command for the next transport this registry creates. */
  command: (mode: { delayMs?: number; initialize?: "fail" }) => string;
  pids: () => number[];
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "webagent-registry-"));
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(callsPath, "");
  return {
    dir,
    callsPath,
    command: ({ delayMs, initialize }) =>
      [
        process.execPath,
        "--experimental-strip-types",
        FIXTURE,
        "shared",
        callsPath,
        delayMs ?? 0,
        initialize ?? "",
      ].join(" "),
    pids: () => {
      try {
        return readFileSync(`${callsPath}.pid`, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => Number(line));
      } catch {
        // The child has not started far enough to record its pid yet.
        return [];
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe("agent registry single-flight", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  function makeRegistry(fx: Fixture) {
    const store = new Store(fx.dir);
    cleanup.push(() => {
      store.close();
      rmSync(fx.dir, { recursive: true, force: true });
    });
    let mode: { delayMs?: number; initialize?: "fail" } = {};
    const registry = new AgentRegistry({
      agents: { "agent-a": { cmd: "placeholder" } },
      defaultAgentId: "agent-a",
      createTransport: (agentId) => {
        const bridge = new AgentBridge(
          fx.command(mode),
          store.sessionView(agentId),
          agentId,
        );
        return bridge;
      },
    });
    cleanup.push(() => registry.shutdownAll());
    return {
      registry,
      setMode: (next: typeof mode) => {
        mode = next;
      },
    };
  }

  it("hands out one process and nothing before it is initialized", async () => {
    const fx = fixture();
    const { registry, setMode } = makeRegistry(fx);
    setMode({ delayMs: 300 });

    const first = registry.resolve("agent-a");
    // A second caller during the handshake joins the flight rather than
    // starting another process.
    const second = registry.resolve("agent-a");
    const adapter = registry.adapterFor("agent-a");

    // A half-started bridge is not usable: `connection` exists before
    // `initialize` finishes, so this is the exact window that used to leak.
    await waitFor(() => fx.pids().length === 1);
    assert.equal(adapter.isAvailable(), false);
    assert.equal(registry.existing("agent-a"), adapter);

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b, "both callers got the same adapter");
    assert.equal(fx.pids().length, 1, "exactly one process was spawned");
    assert.equal(adapter.isAvailable(), true);
    assert.equal(fx.pids().filter((pid) => isAlive(pid)).length, 1);
  });

  it("cleans up a live process whose initialize is refused, then retries", async () => {
    const fx = fixture();
    const { registry, setMode } = makeRegistry(fx);
    setMode({ initialize: "fail" });

    await assert.rejects(
      () => registry.resolve("agent-a"),
      (error: Error) => error.name === "AgentUnavailableError",
    );
    await waitFor(() => fx.pids().length === 1);
    const failedPid = fx.pids()[0];
    // The process answered (it was alive to refuse) and must now be gone.
    await waitFor(() => !isAlive(failedPid), 5000);
    assert.equal(registry.adapterFor("agent-a").isAvailable(), false);

    // The same agent retries successfully on a fresh process.
    setMode({});
    const adapter = await registry.resolve("agent-a");
    assert.equal(adapter.isAvailable(), true);
    assert.equal(fx.pids().length, 2);
    assert.ok(isAlive(fx.pids()[1]));
  });

  it("does not run a reload beside a start, and makes resolve wait for it", async () => {
    const fx = fixture();
    const { registry, setMode } = makeRegistry(fx);
    setMode({ delayMs: 300 });
    const starting = registry.resolve("agent-a");
    await waitFor(() => fx.pids().length === 1);

    // A reload while the start flight is open is refused rather than starting
    // a second process; that is the "two processes at once" failure.
    await assert.rejects(
      () => registry.reload("agent-a", async () => {}),
      /Already reloading/,
    );
    await starting;
    assert.equal(fx.pids().length, 1);

    // A reload now owns the flight, and a concurrent resolve joins it instead
    // of starting another process.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inReload!: () => void;
    const reachedReload = new Promise<void>((resolve) => {
      inReload = resolve;
    });
    // A real restart: the transport goes down first, so the adapter is
    // genuinely unavailable while the reload holds the flight. That is what
    // makes a missing flight observable as a second process.
    const firstPid = fx.pids()[0];
    let restarted!: () => void;
    const reload = registry.reload("agent-a", async (adapter) => {
      const bridge = adapter.bridge as unknown as {
        shutdown: () => Promise<void>;
        start: () => Promise<void>;
      };
      await bridge.shutdown();
      inReload();
      await gate;
      await bridge.start();
      restarted = () => {};
    });
    await reachedReload;
    assert.equal(
      registry.adapterFor("agent-a").isAvailable(),
      false,
      "the adapter is down while the reload is in flight",
    );
    assert.equal(isAlive(firstPid), false, "the old process is gone");

    const duringReload = registry.resolve("agent-a");
    release();
    await reload;
    assert.ok(restarted);
    const adapter = await duringReload;
    assert.equal(adapter, registry.existing("agent-a"));
    // The restart itself spawns one replacement, so two processes were ever
    // created; only one may be alive, and a resolve that started its own would
    // have made it three.
    assert.equal(
      fx.pids().length,
      2,
      "the concurrent resolve joined the reload instead of starting a process",
    );
    assert.equal(
      fx.pids().filter((pid) => isAlive(pid)).length,
      1,
      "exactly one process is alive after the reload",
    );
    assert.equal(adapter.isAvailable(), true, "the reload brought it back");
  });

  it("shuts down every transport it created, bound or not", async () => {
    const fx = fixture();
    const { registry } = makeRegistry(fx);
    await registry.resolve("agent-a");
    const pid = fx.pids()[0];
    assert.ok(isAlive(pid));

    // Unbind the adapter first: shutdownAll must still reach the transport.
    registry.adapterFor("agent-a").bindBridge(null);
    await registry.shutdownAll();
    await waitFor(() => !isAlive(pid), 5000);
    assert.equal(registry.listExisting().length, 0);
  });
});
