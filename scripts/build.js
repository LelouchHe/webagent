#!/usr/bin/env node
// Build script: bundles frontend TS via esbuild, copies static assets to dist/.
// Usage: node scripts/build.js [--dev] [--watch]
//   --dev    Output to dist-dev/, no minification, no content hashing
//   --watch  Watch mode (implies --dev)

import {
  readFile,
  writeFile,
  cp,
  rm,
  readdir,
  watch as fsWatch,
  stat,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { build, context } from "esbuild";

const args = process.argv.slice(2);
const isDev = args.includes("--dev") || args.includes("--watch");
const isWatch = args.includes("--watch");
const SRC = "public";
const OUT = isDev ? "dist-dev" : "dist";

async function buildBundledCss() {
  const main = await readFile(join(OUT, "styles.css"), "utf-8");
  // Bundle hljs themes locally (no CDN). Light is the default; dark overrides
  // when [data-theme="dark"] is set explicitly OR when [data-theme="auto"]
  // and the OS prefers dark. Native CSS nesting (Chrome 120+, Safari 16.5+,
  // Firefox 117+) re-prefixes the .hljs selectors at runtime.
  const lightCss = await readFile(
    join("node_modules", "highlight.js", "styles", "github.css"),
    "utf-8",
  );
  const darkCss = await readFile(
    join("node_modules", "highlight.js", "styles", "github-dark.css"),
    "utf-8",
  );
  return [
    main,
    "\n/* --- highlight.js themes (vendored from highlight.js@common, BSD-3-Clause) --- */\n",
    "/* light: default */\n",
    lightCss,
    "\n/* dark: explicit */\n",
    `[data-theme="dark"] {\n${darkCss}\n}\n`,
    "\n/* dark: auto + system prefers dark */\n",
    `@media (prefers-color-scheme: dark) {\n  [data-theme="auto"] {\n${darkCss}\n  }\n}\n`,
  ].join("");
}

const KEEP_HASHED_VERSIONS = 2;

/**
 * Extract chunk filenames that the given JS source statically imports.
 * Matches both './chunk.HASH.js' (relative) and '/js/chunk.HASH.js' (absolute).
 */
function extractChunkRefs(src) {
  const re = /["'`](?:\.\/)?(?:\/js\/)?(chunk\.[A-Za-z0-9_-]+\.js)["'`]/g;
  const found = new Set();
  for (const m of src.matchAll(re)) found.add(m[1]);
  return [...found];
}

/**
 * Inject <link rel="modulepreload"> tags for each chunk into the HTML <head>,
 * just before </head>. Idempotent: existing modulepreload tags for chunks
 * not in `chunks` are stripped first.
 *
 * `prefix` controls the URL path used in href; default `/js/` (main app),
 * `/s/_/` for the share viewer so all its assets stay under one prefix.
 */
function injectModulePreload(html, chunks, prefix = "/js/") {
  // Strip any pre-existing modulepreload tags pointing at ANY chunk path.
  html = html.replace(
    /\s*<link\s+rel=["']modulepreload["']\s+href=["'][^"']*chunk\.[A-Za-z0-9_-]+\.js["']\s*\/?\s*>/g,
    "",
  );
  if (chunks.length === 0) return html;
  const tags = chunks
    .map((c) => `<link rel="modulepreload" href="${prefix}${c}">`)
    .join("\n");
  return html.replace("</head>", `${tags}\n</head>`);
}

async function copyStaticAssets(bundles) {
  // bundles = { app, login, viewer } — each is the JS filename (hashed in prod).
  // Copy static assets (everything except js/)
  for (const entry of await readdir(SRC)) {
    if (entry === "js") continue;
    await cp(join(SRC, entry), join(OUT, entry), { recursive: true });
  }

  if (isDev) {
    // Dev: write bundled CSS + rewrite index.html + login.html + share-viewer.html
    // to point to un-hashed bundles.
    const cssContent = await buildBundledCss();
    await writeFile(join(OUT, "styles.css"), cssContent);

    let html = await readFile(join(OUT, "index.html"), "utf-8");
    html = html.replace(
      'type="module" src="/js/app.js"',
      `type="module" src="/js/${bundles.app}"`,
    );
    await writeFile(join(OUT, "index.html"), html);

    let loginHtml = await readFile(join(OUT, "login.html"), "utf-8");
    loginHtml = loginHtml.replace(
      'type="module" src="/js/login.js"',
      `type="module" src="/js/${bundles.login}"`,
    );
    await writeFile(join(OUT, "login.html"), loginHtml);

    // share-viewer.html: rewrite asset URLs to /s/_/ namespace so the viewer
    // is fully self-contained (single CF Access bypass / proxy rule on /s/*).
    const sv = join(OUT, "share-viewer.html");
    let svHtml = await readFile(sv, "utf-8");
    svHtml = svHtml.replace("/styles.css", "/s/_/styles.css");
    svHtml = svHtml.replace("/share-viewer.css", "/s/_/share-viewer.css");
    if (!svHtml.includes('src="/js/share/viewer')) {
      svHtml = svHtml.replace(
        "</body>",
        `<script type="module" src="/s/_/${bundles.viewer}"></script>\n</body>`,
      );
    }
    // Dev splitting still emits hashed chunk.*.js — rewrite modulepreload too.
    const viewerSrcDev = await readFile(
      join(OUT, "js", bundles.viewer),
      "utf-8",
    );
    const viewerChunksDev = extractChunkRefs(viewerSrcDev);
    svHtml = injectModulePreload(svHtml, viewerChunksDev, "/s/_/");
    await writeFile(sv, svHtml);
  } else {
    // Production: bundle + hash CSS, hash share-viewer.css, rewrite HTML.
    const cssContent = await buildBundledCss();
    const cssHash = hashString(cssContent);
    const newCss = `styles.${cssHash}.css`;
    await writeFile(join(OUT, newCss), cssContent);
    await rm(join(OUT, "styles.css"));

    // share-viewer.css gets its own hash (separate file, no hljs bundling).
    const svCssContent = await readFile(join(OUT, "share-viewer.css"), "utf-8");
    const svCssHash = hashString(svCssContent);
    const newSvCss = `share-viewer.${svCssHash}.css`;
    await writeFile(join(OUT, newSvCss), svCssContent);
    await rm(join(OUT, "share-viewer.css"));

    // Discover chunks each entry bundle statically imports, for modulepreload.
    const appSrc = await readFile(join(OUT, "js", bundles.app), "utf-8");
    const appChunks = extractChunkRefs(appSrc);
    const viewerSrc = await readFile(join(OUT, "js", bundles.viewer), "utf-8");
    const viewerChunks = extractChunkRefs(viewerSrc);

    let html = await readFile(join(OUT, "index.html"), "utf-8");
    html = html.replace("/styles.css", `/${newCss}`);
    html = html.replace(
      'type="module" src="/js/app.js"',
      `type="module" src="/js/${bundles.app}"`,
    );
    html = injectModulePreload(html, appChunks);
    await writeFile(join(OUT, "index.html"), html);

    let loginHtml = await readFile(join(OUT, "login.html"), "utf-8");
    loginHtml = loginHtml.replace("/styles.css", `/${newCss}`);
    loginHtml = loginHtml.replace(
      'type="module" src="/js/login.js"',
      `type="module" src="/js/${bundles.login}"`,
    );
    await writeFile(join(OUT, "login.html"), loginHtml);

    let svHtml = await readFile(join(OUT, "share-viewer.html"), "utf-8");
    svHtml = svHtml.replace("/styles.css", `/s/_/${newCss}`);
    svHtml = svHtml.replace("/share-viewer.css", `/s/_/${newSvCss}`);
    if (!svHtml.includes('src="/js/share/viewer')) {
      svHtml = svHtml.replace(
        "</body>",
        `<script type="module" src="/s/_/${bundles.viewer}"></script>\n</body>`,
      );
    }
    svHtml = injectModulePreload(svHtml, viewerChunks, "/s/_/");
    await writeFile(join(OUT, "share-viewer.html"), svHtml);

    console.log(
      `Build complete → ${bundles.app} (+${appChunks.length} chunk${appChunks.length === 1 ? "" : "s"}), ${bundles.login}, ${bundles.viewer} (+${viewerChunks.length} chunk${viewerChunks.length === 1 ? "" : "s"}), ${newCss}, ${newSvCss}`,
    );
  }
}

async function pruneOldHashedAssets() {
  // Keep newest N hashed bundles; delete older ones. Dev builds don't hash so this is a no-op there.
  if (isDev) return;

  const jsDir = join(OUT, "js");

  const jsEntries = (await readdir(jsDir, { withFileTypes: true })).filter(
    (e) => e.isFile() && /^app\.[a-zA-Z0-9]+\.js$/.test(e.name),
  );
  const jsSorted = await sortByMtimeDesc(
    jsDir,
    jsEntries.map((e) => e.name),
  );
  const keepApp = jsSorted.slice(0, KEEP_HASHED_VERSIONS);
  for (const f of jsSorted.slice(KEEP_HASHED_VERSIONS)) {
    await rm(join(jsDir, f), { force: true });
  }

  const loginEntries = (await readdir(jsDir, { withFileTypes: true })).filter(
    (e) => e.isFile() && /^login\.[a-zA-Z0-9]+\.js$/.test(e.name),
  );
  const loginSorted = await sortByMtimeDesc(
    jsDir,
    loginEntries.map((e) => e.name),
  );
  const keepLogin = loginSorted.slice(0, KEEP_HASHED_VERSIONS);
  for (const f of loginSorted.slice(KEEP_HASHED_VERSIONS)) {
    await rm(join(jsDir, f), { force: true });
  }

  const viewerEntries = (await readdir(jsDir, { withFileTypes: true })).filter(
    (e) => e.isFile() && /^viewer\.[a-zA-Z0-9]+\.js$/.test(e.name),
  );
  const viewerSorted = await sortByMtimeDesc(
    jsDir,
    viewerEntries.map((e) => e.name),
  );
  const keepViewer = viewerSorted.slice(0, KEEP_HASHED_VERSIONS);
  for (const f of viewerSorted.slice(KEEP_HASHED_VERSIONS)) {
    await rm(join(jsDir, f), { force: true });
  }

  // Reachability-aware chunk prune: any chunk referenced by a retained app,
  // login, or viewer bundle MUST be kept, even if older by mtime. This
  // prevents in-flight tabs (loaded against the previous [name].[hash].js)
  // from 404-ing on lazy imports during a deploy. Anything else can be deleted.
  //
  // CRITICAL: the walk MUST be transitive. esbuild can split a lazy
  // `import()` out of an already-shared chunk, producing a 3rd-level chunk
  // that NO entry bundle imports directly (real example: hljs is dynamically
  // imported from highlight.ts, which itself lives in a shared chunk →
  // chunk → chunk path). A non-recursive scan would prune that grand-child
  // chunk and break dynamic imports at runtime (silent feature breakage +
  // console 404). Walk via BFS until the reachable set stops growing.
  const reachableChunks = new Set();
  const queue = [];
  for (const f of [...keepApp, ...keepLogin, ...keepViewer]) {
    const src = await readFile(join(jsDir, f), "utf-8");
    for (const c of extractChunkRefs(src)) {
      if (!reachableChunks.has(c)) {
        reachableChunks.add(c);
        queue.push(c);
      }
    }
  }
  while (queue.length > 0) {
    const c = queue.shift();
    let src;
    try {
      src = await readFile(join(jsDir, c), "utf-8");
    } catch {
      // Chunk was already pruned in a previous run (or was never emitted
      // because of a partial build). Nothing to walk; downstream chunks
      // it would have referenced are already broken — surfacing that as a
      // build failure is out of scope here.
      continue;
    }
    for (const inner of extractChunkRefs(src)) {
      if (!reachableChunks.has(inner)) {
        reachableChunks.add(inner);
        queue.push(inner);
      }
    }
  }
  const chunkEntries = (await readdir(jsDir, { withFileTypes: true })).filter(
    (e) => e.isFile() && /^chunk\.[A-Za-z0-9_-]+\.js$/.test(e.name),
  );
  for (const e of chunkEntries) {
    if (!reachableChunks.has(e.name)) {
      await rm(join(jsDir, e.name), { force: true });
    }
  }

  const rootEntries = (await readdir(OUT, { withFileTypes: true })).filter(
    (e) =>
      e.isFile() && /^(styles|share-viewer)\.[a-zA-Z0-9]+\.css$/.test(e.name),
  );
  const cssSorted = await sortByMtimeDesc(
    OUT,
    rootEntries.map((e) => e.name),
  );
  // Group by family so we keep N of each, not N total.
  const byFamily = { styles: [], "share-viewer": [] };
  for (const f of cssSorted) {
    const fam = f.startsWith("styles.") ? "styles" : "share-viewer";
    byFamily[fam].push(f);
  }
  for (const fam of Object.keys(byFamily)) {
    for (const f of byFamily[fam].slice(KEEP_HASHED_VERSIONS)) {
      await rm(join(OUT, f), { force: true });
    }
  }
}

async function sortByMtimeDesc(dir, names) {
  const withStat = await Promise.all(
    names.map(async (n) => ({ n, mtime: (await stat(join(dir, n))).mtimeMs })),
  );
  withStat.sort((a, b) => b.mtime - a.mtime);
  return withStat.map((x) => x.n);
}

async function main() {
  if (isDev) {
    // Dev: wipe fully; un-hashed names so no retention needed.
    await rm(OUT, { recursive: true, force: true });
  } else {
    // Prod: keep OUT so last N hashed bundles survive for in-flight page loads during upgrade.
    // Static assets (index.html, manifest.json, sw.js, icon-*) get overwritten by cp below.
    await mkdir(OUT, { recursive: true });
  }

  const esbuildOptions = {
    entryPoints: [
      join(SRC, "js", "app.ts"),
      join(SRC, "js", "login.ts"),
      join(SRC, "js", "share", "viewer.ts"),
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: join(OUT, "js"),
    entryNames: isDev ? "[name]" : "[name].[hash]",
    chunkNames: "chunk.[hash]",
    splitting: true,
    minify: !isDev,
    external: [],
  };

  if (isWatch) {
    const ctx = await context(esbuildOptions);
    await ctx.watch();
    // Initial build
    await ctx.rebuild();
    await copyStaticAssets({
      app: "app.js",
      login: "login.js",
      viewer: "share/viewer.js",
    });
    console.log(`Dev build ready (watching for changes)…`);

    // Also watch static assets (HTML, CSS) for changes
    const ac = new AbortController();
    (async () => {
      try {
        const watcher = fsWatch(SRC, { recursive: true, signal: ac.signal });
        for await (const event of watcher) {
          if (event.filename && !event.filename.startsWith("js/")) {
            await copyStaticAssets({
              app: "app.js",
              login: "login.js",
              viewer: "share/viewer.js",
            });
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") throw e;
      }
    })();

    process.on("SIGINT", () => {
      ac.abort();
      ctx.dispose();
    });
  } else {
    await build(esbuildOptions);

    const jsFiles = await readdir(join(OUT, "js"));
    const appCandidates = jsFiles.filter(
      (f) => /^app\.[A-Za-z0-9]+\.js$/.test(f) || f === "app.js",
    );
    const loginCandidates = jsFiles.filter(
      (f) => /^login\.[A-Za-z0-9]+\.js$/.test(f) || f === "login.js",
    );
    // esbuild flattens nested entry paths: share/viewer.ts → js/viewer.[hash].js
    const viewerCandidates = jsFiles.filter(
      (f) => /^viewer\.[A-Za-z0-9]+\.js$/.test(f) || f === "viewer.js",
    );
    // esbuild may have left older hashed bundles; pick newest by mtime per family.
    const appSorted = await sortByMtimeDesc(join(OUT, "js"), appCandidates);
    const loginSorted = await sortByMtimeDesc(join(OUT, "js"), loginCandidates);
    const viewerSorted = await sortByMtimeDesc(
      join(OUT, "js"),
      viewerCandidates,
    );
    const bundles = {
      app: appSorted[0],
      login: loginSorted[0],
      viewer: viewerSorted[0],
    };
    await copyStaticAssets(bundles);
    await pruneOldHashedAssets();

    if (isDev)
      console.log(
        `Dev build complete → ${bundles.app}, ${bundles.login}, ${bundles.viewer}`,
      );
  }
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).padStart(8, "0").slice(0, 8);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
