import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";

/**
 * Black-box multi-agent run: the real server process, two configured mock
 * agents, and only HTTP in between.
 *
 * This is the one test that proves the wiring end to end: which process got
 * which session, that the default read is global, that `?agent=` narrows, and
 * that `/clear { agentId }` moves a task onto another agent without starting
 * the agent it left.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(REPO, "test/fixtures/multi-agent-acp-agent.ts");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => {
        resolve(port);
      });
    });
  });
}

interface RunningServer {
  child: ChildProcess;
  baseUrl: string;
  token: string;
  calls: (agent: "alpha" | "beta") => Array<{ method: string }>;
  stop: () => Promise<void>;
}

describe("multi-agent server", () => {
  let dir: string;
  let server: RunningServer;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-multi-e2e-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const port = await freePort();
    const configPath = join(dir, "config.toml");
    const callsPath = (agent: string) => join(dir, `${agent}.calls.jsonl`);
    writeFileSync(callsPath("alpha"), "");
    writeFileSync(callsPath("beta"), "");
    writeFileSync(
      configPath,
      [
        `port = ${port}`,
        `data_dir = ${JSON.stringify(dataDir)}`,
        `public_dir = "dist-dev"`,
        `default_agent = "alpha"`,
        `[agents.alpha]`,
        `cmd = "node --experimental-strip-types ${FIXTURE} shared ${callsPath("alpha")}"`,
        `[agents.beta]`,
        `cmd = "node --experimental-strip-types ${FIXTURE} shared ${callsPath("beta")}"`,
        `[limits]`,
        `bash_output = 1048576`,
        `image_upload = 10485760`,
        `[share]`,
        `enabled = false`,
        `ttl_hours = 0`,
        `csp_enforce = true`,
        `viewer_origin = ""`,
        `internal_hosts = []`,
        "",
      ].join("\n"),
    );
    const token = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(REPO, "scripts/create-token.ts"),
        "e2e",
        "--config",
        configPath,
      ],
      {
        cwd: REPO,
        encoding: "utf8",
        env: { ...process.env, WEBAGENT_NO_LOG: "1" },
      },
    ).trim();

    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(REPO, "src/server.ts"),
        "--config",
        configPath,
      ],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`${baseUrl}/api/v1/tasks`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`server did not start:\n${log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    server = {
      child,
      baseUrl,
      token,
      calls: (agent) =>
        readFileSync(callsPath(agent), "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as { method: string }),
      stop: () =>
        new Promise<void>((resolve) => {
          child.once("exit", () => {
            resolve();
          });
          child.kill("SIGTERM");
          setTimeout(() => {
            child.kill("SIGKILL");
          }, 5000).unref();
        }),
    };
  });

  after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  it("starts no agent until the first task needs one", () => {
    assert.deepEqual(server.calls("alpha"), []);
    assert.deepEqual(server.calls("beta"), []);
  });

  it("serves a task on the default agent, lists it globally and narrows by agent", async () => {
    const boot = await call("POST", "/api/v1/tasks/bootstrap");
    assert.equal(boot.status, 200);
    const task = boot.json as { id: string; agentId: string | null };
    assert.equal(task.agentId, "alpha");

    const all = await call("GET", "/api/v1/tasks");
    const listed = (
      all.json as Array<{ id: string; agentId: string | null }>
    ).find((entry) => entry.id === task.id);
    assert.equal(listed?.agentId, "alpha");

    const narrowed = await call("GET", "/api/v1/tasks?agent=beta");
    assert.deepEqual(
      (narrowed.json as Array<{ id: string }>).filter(
        (entry) => entry.id === task.id,
      ),
      [],
    );

    // Only the default agent has a process; beta is still untouched.
    assert.ok(server.calls("alpha").some((entry) => entry.method === "new"));
    assert.deepEqual(server.calls("beta"), []);
  });

  it("rescues a task onto another agent with an explicit clear", async () => {
    const boot = await call("POST", "/api/v1/tasks/bootstrap");
    const task = boot.json as { id: string };
    const alphaSessionsBefore = server
      .calls("alpha")
      .filter((entry) => entry.method === "new").length;

    const cleared = await call("POST", `/api/v1/tasks/${task.id}/clear`, {
      agentId: "beta",
    });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.json as { agentId: string }).agentId, "beta");

    // The replacement execution lives on beta, and alpha did not start one.
    assert.equal(
      server.calls("beta").filter((entry) => entry.method === "new").length,
      1,
    );
    assert.equal(
      server.calls("alpha").filter((entry) => entry.method === "new").length,
      alphaSessionsBefore,
    );

    const narrowed = await call("GET", "/api/v1/tasks?agent=beta");
    assert.ok(
      (narrowed.json as Array<{ id: string }>).some(
        (entry) => entry.id === task.id,
      ),
    );
  });

  it("keeps reads and deletes working after an agent is gone", async () => {
    // An explicit task, not whatever bootstrap would resume: Root reset has
    // its own lifecycle.
    const created = await call("POST", "/api/v1/tasks", {});
    assert.equal(created.status, 201);
    const task = created.json as { id: string };
    // Reading never resolves an execution, so it is safe to hammer.
    for (let i = 0; i < 3; i++) {
      const read = await call("GET", `/api/v1/tasks/${task.id}`);
      assert.equal(read.status, 200);
      const snapshot = await call("GET", `/api/v1/tasks/${task.id}/snapshot`);
      assert.equal(snapshot.status, 200);
    }
    const removed = await call("DELETE", `/api/v1/tasks/${task.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await call("GET", `/api/v1/tasks/${task.id}`)).status, 404);
  });
});
