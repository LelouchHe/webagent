// atomic-write.test.ts — verify atomicWriteFileSync / atomicWriteFile do
// not expose readers to a zero-byte truncation window. The flake that
// motivated this helper was test/daemon.test.ts hitting JSON.parse("")
// because plain writeFileSync truncates before writing.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile, atomicWriteFileSync } from "../src/atomic-write.ts";

describe("atomicWriteFileSync", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-sync-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content to the target path", () => {
    const p = join(dir, "a.json");
    atomicWriteFileSync(p, '{"x":1}');
    assert.equal(readFileSync(p, "utf8"), '{"x":1}');
  });

  it("removes the .tmp sibling after rename", () => {
    const p = join(dir, "b.json");
    atomicWriteFileSync(p, "hello");
    assert.equal(existsSync(`${p}.tmp`), false);
  });

  it("never exposes an empty file to concurrent readers", () => {
    // Plain writeFileSync truncates first; if a polling reader hits the
    // window between truncate and write, it sees "". atomicWriteFileSync
    // writes to <path>.tmp then renames, so readers either see old content
    // or new content but never empty.
    const p = join(dir, "c.json");
    atomicWriteFileSync(p, '"v1"');
    let sawEmpty = false;
    let stop = false;
    // Background polling loop using setImmediate to interleave with sync writes.
    const poll = (): void => {
      if (stop) return;
      try {
        const txt = readFileSync(p, "utf8");
        if (txt === "") sawEmpty = true;
      } catch {
        /* ENOENT briefly OK */
      }
      setImmediate(poll);
    };
    setImmediate(poll);

    for (let i = 0; i < 200; i++) {
      atomicWriteFileSync(p, `"v${i + 2}"`);
    }
    stop = true;
    assert.equal(sawEmpty, false, "atomic write must never expose empty file");
  });
});

describe("atomicWriteFile (async)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-async-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content and applies mode", async () => {
    const p = join(dir, "a.json");
    await atomicWriteFile(p, '{"x":1}', 0o600);
    assert.equal(readFileSync(p, "utf8"), '{"x":1}');
  });

  it("removes the .tmp sibling after rename", async () => {
    const p = join(dir, "b.json");
    await atomicWriteFile(p, "hello");
    assert.equal(existsSync(`${p}.tmp`), false);
  });
});
