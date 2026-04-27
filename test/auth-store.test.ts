import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStore } from "../src/auth-store.ts";
import { generateToken, hashToken } from "../src/auth.ts";

describe("AuthStore", () => {
  let tmpDir: string;
  let authPath: string;
  let store: AuthStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-auth-"));
    authPath = join(tmpDir, "auth.json");
    store = new AuthStore(authPath);
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init / load", () => {
    it("missing file = empty token list", async () => {
      await store.load();
      assert.deepEqual(store.list(), []);
    });

    it("loads existing tokens from disk", async () => {
      const token = generateToken();
      const data = {
        tokens: [
          {
            name: "laptop",
            scope: "admin",
            hash: hashToken(token),
            createdAt: 1000,
            lastUsedAt: null,
          },
        ],
      };
      writeFileSync(authPath, JSON.stringify(data), { mode: 0o600 });
      await store.load();
      const list = store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, "laptop");
      assert.equal(list[0].scope, "admin");
    });

    it("rejects malformed JSON gracefully", async () => {
      writeFileSync(authPath, "not json", { mode: 0o600 });
      await assert.rejects(() => store.load());
    });
  });

  describe("addToken", () => {
    it("creates a token, persists to disk", async () => {
      await store.load();
      const { token, record } = await store.addToken("laptop", "admin");
      assert.match(token, /^wat_/);
      assert.equal(record.name, "laptop");
      assert.equal(record.scope, "admin");

      // re-read from disk
      const raw = readFileSync(authPath, "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.tokens.length, 1);
      assert.equal(parsed.tokens[0].name, "laptop");
      assert.equal(parsed.tokens[0].hash, hashToken(token));
    });

    it("file is created with mode 0600", async () => {
      await store.load();
      await store.addToken("laptop", "admin");
      const mode = statSync(authPath).mode & 0o777;
      assert.equal(mode, 0o600);
    });

    it("rejects duplicate name", async () => {
      await store.load();
      await store.addToken("laptop", "admin");
      await assert.rejects(() => store.addToken("laptop", "api"), /exists/i);
    });

    it("rejects invalid name", async () => {
      await store.load();
      await assert.rejects(() => store.addToken("", "admin"));
      await assert.rejects(() => store.addToken("has spaces", "admin"));
      await assert.rejects(() => store.addToken("../etc", "admin"));
    });
  });

  describe("revokeToken", () => {
    it("removes the token", async () => {
      await store.load();
      await store.addToken("laptop", "admin");
      const removed = await store.revokeToken("laptop");
      assert.equal(removed, true);
      assert.equal(store.list().length, 0);
    });

    it("returns false if token missing", async () => {
      await store.load();
      assert.equal(await store.revokeToken("nonexistent"), false);
    });

    it("revoked token cannot be found via findByToken", async () => {
      await store.load();
      const { token } = await store.addToken("laptop", "admin");
      await store.revokeToken("laptop");
      assert.equal(store.findByToken(token), null);
    });
  });

  describe("findByToken", () => {
    it("returns matching record", async () => {
      await store.load();
      const { token } = await store.addToken("laptop", "admin");
      const found = store.findByToken(token);
      assert.ok(found);
      assert.equal(found.name, "laptop");
    });

    it("returns null for unknown token", async () => {
      await store.load();
      assert.equal(store.findByToken("wat_nonexistent"), null);
    });

    it("returns null for malformed token", async () => {
      await store.load();
      assert.equal(store.findByToken(""), null);
      assert.equal(store.findByToken("not-a-token"), null);
    });
  });

  describe("touchLastUsed", () => {
    it("updates lastUsedAt in memory immediately", async () => {
      await store.load();
      const { token } = await store.addToken("laptop", "admin");
      const before = store.findByToken(token)!.lastUsedAt;
      assert.equal(before, null);
      store.touchLastUsed(token);
      const after = store.findByToken(token)!.lastUsedAt;
      assert.ok(after && after > 0);
    });

    it("does not flush to disk on every call (in-memory only)", async () => {
      await store.load();
      const { token } = await store.addToken("laptop", "admin");
      const beforeMtime = statSync(authPath).mtimeMs;
      // many touches
      for (let i = 0; i < 50; i++) store.touchLastUsed(token);
      const afterMtime = statSync(authPath).mtimeMs;
      assert.equal(beforeMtime, afterMtime);
    });

    it("flushes to disk when flush() called", async () => {
      await store.load();
      const { token } = await store.addToken("laptop", "admin");
      store.touchLastUsed(token);
      await store.flush();
      const raw = JSON.parse(readFileSync(authPath, "utf8"));
      assert.ok(raw.tokens[0].lastUsedAt);
    });
  });

  describe("concurrency: merge-on-flush", () => {
    it("preserves external revoke when flushing", async () => {
      // Scenario: server has token in memory + a flush pending.
      // Meanwhile, CLI revokes the token by editing the file directly.
      // Server flush MUST NOT resurrect the revoked token.
      await store.load();
      const { token } = await store.addToken("laptop", "admin");
      store.touchLastUsed(token);

      // External process (CLI) revokes by writing the file with empty tokens.
      writeFileSync(authPath, JSON.stringify({ tokens: [] }), { mode: 0o600 });

      await store.flush();

      // After flush, server state should reconcile with disk -> token gone.
      const raw = JSON.parse(readFileSync(authPath, "utf8"));
      assert.equal(raw.tokens.length, 0);
    });

    it("preserves external add when flushing", async () => {
      // Scenario: CLI adds a token while server is flushing lastUsedAt.
      // The new token must survive.
      await store.load();
      const { token: serverToken } = await store.addToken("server", "admin");
      store.touchLastUsed(serverToken);

      // External process adds a new token.
      const cliToken = generateToken();
      const data = JSON.parse(readFileSync(authPath, "utf8"));
      data.tokens.push({
        name: "cli",
        scope: "admin",
        hash: hashToken(cliToken),
        createdAt: Date.now(),
        lastUsedAt: null,
      });
      writeFileSync(authPath, JSON.stringify(data), { mode: 0o600 });

      await store.flush();

      const raw = JSON.parse(readFileSync(authPath, "utf8"));
      const names = raw.tokens.map((t: { name: string }) => t.name).sort();
      assert.deepEqual(names, ["cli", "server"]);
    });
  });

  describe("reload", () => {
    it("reload() picks up external file changes", async () => {
      await store.load();
      assert.equal(store.list().length, 0);
      // External process adds a token.
      const t = generateToken();
      writeFileSync(
        authPath,
        JSON.stringify({
          tokens: [
            {
              name: "external",
              scope: "api",
              hash: hashToken(t),
              createdAt: 1,
              lastUsedAt: null,
            },
          ],
        }),
        { mode: 0o600 },
      );
      await store.reload();
      assert.equal(store.list().length, 1);
      assert.equal(store.list()[0].name, "external");
    });
  });
});
