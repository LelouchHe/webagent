import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Invariants for the hljs-split build output:
 *
 *   1. Production build emits at least one `chunk.[hash].js` file
 *      (esbuild splitting:true). hljs lives in a chunk, NOT inlined in app.
 *   2. The main bundle's gzipped size stays below a generous bound, so a
 *      regression where hljs leaks back into app would fail loudly.
 *   3. Every chunk that `app.[hash].js` statically imports must be referenced
 *      by `<link rel="modulepreload">` in `dist/index.html`, so the browser
 *      starts fetching it in parallel with app.js.
 *   4. Prune is reachability-aware: when a new build replaces the previous
 *      one, the chunk files referenced by the *retained* old `app.[hash].js`
 *      MUST still exist on disk. Otherwise tabs that loaded the old HTML
 *      will fail to fetch the chunk on lazy import during a deploy.
 *
 * These tests run a full `node scripts/build.js` against the real source tree
 * and inspect `dist/`. They are slow-ish (~3-5s) but catch regressions that
 * unit-level tests on highlight.ts would miss (esbuild misconfiguration, HTML
 * injection forgotten, prune deleting active chunks).
 *
 * NOTE: All build assertions live in this single suite to serialize builds.
 * Running parallel build tests against the same OUT dir races.
 */

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const APP_TS = join(ROOT, "public", "js", "app.ts");

function runBuild() {
  execFileSync("node", ["scripts/build.js"], { cwd: ROOT, stdio: "pipe" });
}

function listJs(): string[] {
  return existsSync(join(DIST, "js"))
    ? readdirSync(join(DIST, "js")).filter((n) => n.endsWith(".js"))
    : [];
}

function appBundles(): string[] {
  const names = listJs().filter((n) => /^app\.[A-Za-z0-9_-]+\.js$/.test(n));
  names.sort(
    (a, b) =>
      statSync(join(DIST, "js", b)).mtimeMs -
      statSync(join(DIST, "js", a)).mtimeMs,
  );
  return names;
}

function readApp(): { name: string; src: string } {
  const names = appBundles();
  assert.ok(names.length > 0, "no app.[hash].js found in dist/js");
  const name = names[0];
  return { name, src: readFileSync(join(DIST, "js", name), "utf-8") };
}

function extractChunkRefs(src: string): string[] {
  const re = /["'`](?:\.\/)?(?:\/js\/)?(chunk\.[A-Za-z0-9_-]+\.js)["'`]/g;
  const found = new Set<string>();
  for (const m of src.matchAll(re)) found.add(m[1]);
  return [...found];
}

describe("build output: hljs split", () => {
  let originalAppTs = "";

  before(() => {
    originalAppTs = readFileSync(APP_TS, "utf-8");
    runBuild();
  });

  after(() => {
    // Restore source if a prune test mutated it; rebuild so dist matches source.
    writeFileSync(APP_TS, originalAppTs);
    runBuild();
  });

  it("dist/js/ contains a chunk.[hash].js (splitting:true is enabled)", () => {
    const chunks = listJs().filter((n) =>
      /^chunk\.[A-Za-z0-9_-]+\.js$/.test(n),
    );
    assert.ok(
      chunks.length >= 1,
      `expected at least one chunk.[hash].js in dist/js, found: ${listJs().join(", ")}`,
    );
  });

  it("app.[hash].js gzipped size is below 50KB (no hljs inlined)", () => {
    const { name, src } = readApp();
    const gz = gzipSync(Buffer.from(src)).length;
    assert.ok(
      gz < 50 * 1024,
      `${name} gzip = ${gz} bytes, expected < 51200. ` +
        `If this fails, hljs likely leaked back into the main bundle.`,
    );
  });

  it("app.[hash].js statically imports at least one chunk.[hash].js", () => {
    const { src } = readApp();
    const refs = extractChunkRefs(src);
    assert.ok(
      refs.length >= 1,
      `app bundle does not reference any chunk.[hash].js — splitting may be off ` +
        `or hljs is inlined.`,
    );
  });

  it("dist/index.html has a <link rel='modulepreload'> for every chunk app imports", () => {
    const { src } = readApp();
    const refs = extractChunkRefs(src);
    const html = readFileSync(join(DIST, "index.html"), "utf-8");
    for (const chunk of refs) {
      const re = new RegExp(
        `<link\\s+rel=["']modulepreload["']\\s+href=["']/js/${chunk.replace(
          /\./g,
          "\\.",
        )}["']`,
      );
      assert.match(
        html,
        re,
        `dist/index.html missing <link rel="modulepreload" href="/js/${chunk}">`,
      );
    }
  });

  it("after a second build with different source, retained old app.[hash].js's chunks still exist", () => {
    const before = appBundles();
    assert.ok(before.length >= 1, "no app bundles after first build");
    const oldApp = before[0];
    const oldChunks = extractChunkRefs(
      readFileSync(join(DIST, "js", oldApp), "utf-8"),
    );
    assert.ok(
      oldChunks.length >= 1,
      `old app ${oldApp} references no chunks — splitting must be enabled before this test`,
    );

    // Force a different hash by appending a unique comment to app.ts.
    writeFileSync(APP_TS, originalAppTs + `\n// build-test marker ${Date.now()}\n`);

    runBuild();

    const after2 = appBundles();
    assert.ok(
      after2.includes(oldApp),
      `old app bundle ${oldApp} was pruned after rebuild — KEEP_HASHED_VERSIONS retention broken. ` +
        `dist/js: ${after2.join(", ")}`,
    );

    const surviving = new Set(listJs());
    for (const chunk of oldChunks) {
      assert.ok(
        surviving.has(chunk),
        `chunk ${chunk} (referenced by retained old app ${oldApp}) was pruned. ` +
          `Surviving: ${[...surviving].join(", ")}`,
      );
    }
  });
});
