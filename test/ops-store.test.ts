import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { AuthStore } from "../src/auth-store.ts";
import { OPS_NAMESPACE, opIdentity } from "../src/op-identity.ts";
import { Store } from "../src/store.ts";
import { OPS_TTL_MS } from "../src/store/ops.ts";

const ROOT = process.cwd();

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("OpsStore primitive", () => {
  const dirs: string[] = [];

  function createTempStore(): { dir: string; store: Store } {
    const dir = mkdtempSync(join(tmpdir(), "webagent-ops-store-"));
    dirs.push(dir);
    return { dir, store: new Store(dir) };
  }

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("claims new once, detects pending/conflict/replay, and resets at the 24h TTL boundary", () => {
    const { store } = createTempStore();
    try {
      const t0 = 1_700_000_000_000;
      const key = opIdentity(OPS_NAMESPACE, "token:alice", "op-1");

      // First claim is new.
      assert.deepEqual(store.ops.claim(key, "fp-a", t0), {
        kind: "new",
        createdAt: t0,
      });

      // Same key + same fingerprint while incomplete -> pending.
      assert.deepEqual(store.ops.claim(key, "fp-a", t0 + 1_000), {
        kind: "pending",
      });

      // Same key + different fingerprint while pending -> conflict takes priority over pending.
      assert.deepEqual(store.ops.claim(key, "fp-b", t0 + 1_000), {
        kind: "conflict",
      });

      // Complete with mismatched createdAt does not update; matching createdAt succeeds once.
      const payload = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe]);
      assert.equal(
        store.ops.complete(
          key,
          {
            status: 202,
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
            body: payload,
          },
          t0 + 1,
        ),
        false,
      );
      assert.equal(
        store.ops.complete(
          key,
          {
            status: 202,
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
            body: payload,
          },
          t0,
        ),
        true,
      );
      // Already completed -> second complete returns false.
      assert.equal(
        store.ops.complete(
          key,
          { status: 500, headers: {}, body: Buffer.alloc(0) },
          t0,
        ),
        false,
      );

      // Before TTL (24h - 1ms): same fingerprint replays exact headers & binary Buffer.
      const replayed = store.ops.claim(key, "fp-a", t0 + OPS_TTL_MS - 1);
      assert.equal(replayed.kind, "replay");
      assert.equal(replayed.response.status, 202);
      assert.deepEqual(replayed.response.headers, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      assert.equal(Buffer.isBuffer(replayed.response.body), true);
      assert.deepEqual(replayed.response.body, payload);

      // Before TTL: different fingerprint conflicts (priority over replay).
      assert.deepEqual(store.ops.claim(key, "fp-b", t0 + OPS_TTL_MS - 1), {
        kind: "conflict",
      });

      // At exact TTL boundary (>= 24h): re-claim overwrites with a fresh pending row.
      const tExpired = t0 + OPS_TTL_MS;
      assert.deepEqual(store.ops.claim(key, "fp-b", tExpired), {
        kind: "new",
        createdAt: tExpired,
      });
      assert.deepEqual(store.ops.claim(key, "fp-b", tExpired + 10), {
        kind: "pending",
      });
    } finally {
      store.close();
    }
  });

  it("preserves empty Buffer body for 204 responses", () => {
    const { store } = createTempStore();
    try {
      const t0 = 1_700_000_000_000;
      const key = opIdentity(OPS_NAMESPACE, "token:admin", "op-204");
      assert.deepEqual(store.ops.claim(key, "fp-204", t0), {
        kind: "new",
        createdAt: t0,
      });
      assert.equal(
        store.ops.complete(
          key,
          { status: 204, headers: {}, body: Buffer.alloc(0) },
          t0,
        ),
        true,
      );
      const replayed = store.ops.claim(key, "fp-204", t0 + 100);
      assert.equal(replayed.kind, "replay");
      assert.equal(replayed.response.status, 204);
      assert.deepEqual(replayed.response.headers, {});
      assert.equal(replayed.response.body.length, 0);
    } finally {
      store.close();
    }
  });

  it("sweep removes rows with created_at <= now - 24h while preserving fresh and activeKeys rows", () => {
    const { store } = createTempStore();
    try {
      const t0 = 1_700_000_000_000;
      const kExpired = "key-expired";
      const kBoundary = "key-boundary";
      const kActive = "key-active";
      const kFresh = "key-fresh";

      store.ops.claim(kExpired, "fp", t0);
      store.ops.claim(kBoundary, "fp", t0 + 1_000);
      store.ops.claim(kActive, "fp", t0);
      store.ops.claim(kFresh, "fp", t0 + 1_001);

      const sweepNow = t0 + 1_000 + OPS_TTL_MS;
      const removed = store.ops.sweep(sweepNow, new Set([kActive]));
      assert.equal(removed, 2);

      // Expired + boundary were removed -> fresh claims return new.
      assert.equal(store.ops.claim(kExpired, "fp", sweepNow).kind, "new");
      assert.equal(store.ops.claim(kBoundary, "fp", sweepNow).kind, "new");
      // Fresh row was kept -> still pending (within TTL).
      assert.equal(store.ops.claim(kFresh, "fp", sweepNow).kind, "pending");
      // Active row was NOT deleted by sweep; verify directly in SQLite.
      const db = (store as unknown as { db: Database.Database }).db;
      const activeRow = db
        .prepare("SELECT key, created_at FROM ops WHERE key = ?")
        .get(kActive) as { key: string; created_at: number } | undefined;
      assert.deepEqual(activeRow, { key: kActive, created_at: t0 });
    } finally {
      store.close();
    }
  });

  it("real server.ts sweeps on boot, sweeps hourly without deleting active inFlight keys, and stops timer before store.close()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-ops-server-sweep-"));
    dirs.push(dir);
    const dataDir = join(dir, "data");
    const port = await getFreePort();

    // Seed auth token and pre-existing ops rows (one expired, one fresh).
    const auth = new AuthStore(join(dataDir, "auth.json"));
    await auth.load();
    const { token } = await auth.addToken("ops-admin", "admin");
    await auth.close();

    const baseNow = Date.now();
    const bootExpiredKey = "boot-expired-key";
    const bootFreshKey = "boot-fresh-key";
    const seedStore = new Store(dataDir);
    seedStore.ensureRootTask(dir);
    seedStore.ops.claim(bootExpiredKey, "fp-old", baseNow - OPS_TTL_MS - 1_000);
    seedStore.ops.claim(bootFreshKey, "fp-fresh", baseNow - 60_000);
    seedStore.close();

    // Create a minimal mock ACP agent that holds `session/set_config_option`
    // until a release file appears so a real HTTP write stays inFlight.
    const releaseFile = join(dir, "release-inflight");
    const inflightStartedFile = join(dir, "inflight-started");
    const mockAgentPath = join(dir, "hold-agent.mjs");
    writeFileSync(
      mockAgentPath,
      `
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const releaseFile = ${JSON.stringify(releaseFile)};
const startedFile = ${JSON.stringify(inflightStartedFile)};
const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "hold-agent", version: "1.0.0" },
      },
    });
  } else if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-hold-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "m1",
            options: [
              { value: "m1", name: "M1" },
              { value: "m2", name: "M2" },
            ],
          },
        ],
      },
    });
  } else if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
  } else if (msg.method === "session/set_config_option") {
    writeFileSync(startedFile, "started");
    const poll = setInterval(() => {
      if (existsSync(releaseFile)) {
        clearInterval(poll);
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            configOptions: [
              {
                id: "model",
                name: "Model",
                category: "model",
                currentValue: "m2",
                options: [
                  { value: "m1", name: "M1" },
                  { value: "m2", name: "M2" },
                ],
              },
            ],
          },
        });
      }
    }, 10);
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`,
    );

    // Preload script for real src/server.ts: controllable clock, hourly timer capture,
    // and lifecycle order log (hourly clearInterval vs Database.prototype.close).
    const lifecycleLogPath = join(dir, "lifecycle.jsonl");
    writeFileSync(lifecycleLogPath, "");
    const preloadPath = join(dir, "clock-preload.mjs");
    writeFileSync(
      preloadPath,
      `
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

const logPath = ${JSON.stringify(lifecycleLogPath)};
const record = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\\n");

let fakeNow = ${baseNow};
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fakeNow);
    else super(...args);
  }
  static now() {
    return fakeNow;
  }
}
globalThis.Date = FakeDate;

let hourlyHandle = null;
let hourlyCb = null;
const origSetInterval = globalThis.setInterval;
const origClearInterval = globalThis.clearInterval;

globalThis.setInterval = function (cb, ms, ...args) {
  const handle = origSetInterval.call(this, cb, ms, ...args);
  if (ms === 3_600_000) {
    hourlyHandle = handle;
    hourlyCb = cb;
    record({ event: "hourly_timer_registered" });
  }
  return handle;
};

globalThis.clearInterval = function (handle) {
  if (handle && handle === hourlyHandle) {
    record({ event: "hourly_timer_cleared" });
  }
  return origClearInterval.call(this, handle);
};

const require = createRequire(${JSON.stringify(join(ROOT, "package.json"))});
const BetterSqlite3 = require("better-sqlite3");
const origClose = BetterSqlite3.prototype.close;
BetterSqlite3.prototype.close = function (...args) {
  record({ event: "db_close" });
  return origClose.apply(this, args);
};

process.on("SIGUSR2", () => {
  fakeNow += ${OPS_TTL_MS + 3_600_000};
  if (hourlyCb) {
    hourlyCb();
    record({ event: "hourly_timer_fired", now: fakeNow });
  }
});
`,
    );

    const cfgPath = join(dir, "config.toml");
    writeFileSync(
      cfgPath,
      `port = ${port}\ndata_dir = ${JSON.stringify(dataDir)}\ndefault_cwd = ${JSON.stringify(dir)}\ndefault_agent = "hold"\n` +
        `[agents.hold]\ncmd = ${JSON.stringify(`${process.execPath} ${mockAgentPath}`)}\n`,
    );

    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        pathToFileURL(preloadPath).href,
        join(ROOT, "src", "server.ts"),
        "--config",
        cfgPath,
      ],
      {
        env: { ...process.env, WEBAGENT_STARTUP_CHECKED: "1" },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const readOpsKeys = (): string[] => {
      const ro = new Database(join(dataDir, "webagent.db"), { readonly: true });
      try {
        return (
          ro.prepare("SELECT key FROM ops ORDER BY key").all() as Array<{
            key: string;
          }>
        ).map((r) => r.key);
      } finally {
        ro.close();
      }
    };

    const readEvents = (): Array<{ event: string }> =>
      readFileSync(lifecycleLogPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string });

    try {
      await waitUntil(
        () => stdout.includes("[server] listening on"),
        10_000,
        `server startup (exit=${child.exitCode}, stdout=${stdout}, stderr=${stderr})`,
      );

      // 1. Startup sweep ran before accepting requests: expired row gone, fresh row intact.
      assert.deepEqual(readOpsKeys(), [bootFreshKey]);

      // 2. Create a task and start a held write with X-Client-Op-Id so its key is live inFlight.
      const createRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agentId: "hold" }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as { id: string };

      const liveOpId = `op-inflight-${randomUUID()}`;
      const liveOpKey = opIdentity(OPS_NAMESPACE, "token:ops-admin", liveOpId);
      const pendingModelWrite = fetch(
        `http://127.0.0.1:${port}/api/v1/tasks/${created.id}/config/model`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Client-Op-Id": liveOpId,
          },
          body: JSON.stringify({ value: "m2" }),
        },
      );

      await waitUntil(
        () => {
          try {
            return readFileSync(inflightStartedFile, "utf-8") === "started";
          } catch {
            return false;
          }
        },
        10_000,
        "held write to enter inFlight",
      );

      // Both bootFreshKey and liveOpKey are in `ops` right now.
      assert.deepEqual(readOpsKeys().sort(), [bootFreshKey, liveOpKey].sort());

      // 3. Advance fake clock by 25h and trigger the hourly timer via SIGUSR2.
      child.kill("SIGUSR2");
      await waitUntil(
        () => readEvents().some((e) => e.event === "hourly_timer_fired"),
        5_000,
        "hourly timer fire",
      );

      // bootFreshKey expired and was swept; liveOpKey survived because it is in activeOpKeys!
      assert.deepEqual(readOpsKeys(), [liveOpKey]);

      // Release the held write and verify it completes cleanly and replays.
      writeFileSync(releaseFile, "go");
      const firstWriteRes = await pendingModelWrite;
      assert.equal(firstWriteRes.status, 200);

      // 4. Shutdown: hourly timer must be cleared BEFORE store.close().
      child.kill("SIGTERM");
      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.once("exit", (code) => {
          resolve(code);
        });
      });
      assert.equal(exitCode, 0, `unexpected stderr: ${stderr}`);

      const events = readEvents().map((e) => e.event);
      const firedIdx = events.indexOf("hourly_timer_fired");
      const clearedIdx = events.indexOf("hourly_timer_cleared");
      const shutdownDbCloseIdx = events.lastIndexOf("db_close");
      const eventSummary = events.join(", ");
      assert.ok(
        firedIdx >= 0,
        `expected hourly_timer_fired in ${eventSummary}`,
      );
      assert.ok(
        clearedIdx > firedIdx,
        `expected hourly_timer_cleared after fire in ${eventSummary}`,
      );
      assert.ok(
        shutdownDbCloseIdx > clearedIdx,
        `hourly_timer_cleared (${clearedIdx}) must run before shutdown db_close (${shutdownDbCloseIdx}) in ${eventSummary}`,
      );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          child.once("exit", () => {
            resolve();
          });
        });
      }
    }
  });
});
