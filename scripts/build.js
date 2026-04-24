#!/usr/bin/env node
// Build script: bundles frontend TS via esbuild, copies static assets to dist/.
// Usage: node scripts/build.js [--dev] [--watch]
//   --dev    Output to dist-dev/, no minification, no content hashing
//   --watch  Watch mode (implies --dev)

import { readFile, writeFile, cp, rm, readdir, watch as fsWatch, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build, context } from 'esbuild';

const args = process.argv.slice(2);
const isDev = args.includes('--dev') || args.includes('--watch');
const isWatch = args.includes('--watch');
const SRC = 'public';
const OUT = isDev ? 'dist-dev' : 'dist';

async function copyStaticAssets(bundleFile) {
  // Copy static assets (everything except js/)
  for (const entry of await readdir(SRC)) {
    if (entry === 'js') continue;
    await cp(join(SRC, entry), join(OUT, entry), { recursive: true });
  }

  if (isDev) {
    // Dev: rewrite index.html to point to the un-hashed bundle
    let html = await readFile(join(OUT, 'index.html'), 'utf-8');
    html = html.replace('type="module" src="/js/app.js"', `src="/js/${bundleFile}"`);
    await writeFile(join(OUT, 'index.html'), html);
  } else {
    // Production: hash CSS and rewrite index.html
    const cssContent = await readFile(join(OUT, 'styles.css'), 'utf-8');
    const cssHash = hashString(cssContent);
    const newCss = `styles.${cssHash}.css`;
    await writeFile(join(OUT, newCss), cssContent);
    await rm(join(OUT, 'styles.css'));

    let html = await readFile(join(OUT, 'index.html'), 'utf-8');
    html = html.replace('/styles.css', `/${newCss}`);
    html = html.replace('type="module" src="/js/app.js"', `src="/js/${bundleFile}"`);
    await writeFile(join(OUT, 'index.html'), html);

    console.log(`Build complete → ${bundleFile}, ${newCss}`);
  }
}

const KEEP_HASHED_VERSIONS = 2;

async function pruneOldHashedAssets() {
  // Keep newest N hashed bundles; delete older ones. Dev builds don't hash so this is a no-op there.
  if (isDev) return;

  const jsDir = join(OUT, 'js');
  const jsEntries = (await readdir(jsDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /^app\.[a-zA-Z0-9]+\.js$/.test(e.name));
  const jsSorted = await sortByMtimeDesc(jsDir, jsEntries.map((e) => e.name));
  for (const f of jsSorted.slice(KEEP_HASHED_VERSIONS)) {
    await rm(join(jsDir, f), { force: true });
  }

  const rootEntries = (await readdir(OUT, { withFileTypes: true }))
    .filter((e) => e.isFile() && /^styles\.[a-zA-Z0-9]+\.css$/.test(e.name));
  const cssSorted = await sortByMtimeDesc(OUT, rootEntries.map((e) => e.name));
  for (const f of cssSorted.slice(KEEP_HASHED_VERSIONS)) {
    await rm(join(OUT, f), { force: true });
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
    entryPoints: [join(SRC, 'js', 'app.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: join(OUT, 'js'),
    entryNames: isDev ? '[name]' : '[name].[hash]',
    minify: !isDev,
    external: [],
  };

  if (isWatch) {
    const ctx = await context(esbuildOptions);
    await ctx.watch();
    // Initial build
    await ctx.rebuild();
    await copyStaticAssets('app.js');
    console.log(`Dev build ready (watching for changes)…`);

    // Also watch static assets (HTML, CSS) for changes
    const ac = new AbortController();
    (async () => {
      try {
        const watcher = fsWatch(SRC, { recursive: true, signal: ac.signal });
        for await (const event of watcher) {
          if (event.filename && !event.filename.startsWith('js/')) {
            await copyStaticAssets('app.js');
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      }
    })();

    process.on('SIGINT', () => { ac.abort(); ctx.dispose(); });
  } else {
    await build(esbuildOptions);

    const jsFiles = (await readdir(join(OUT, 'js'))).filter(f => f.endsWith('.js'));
    // esbuild may have left older hashed bundles from prior builds; pick the newest by mtime.
    const sorted = await sortByMtimeDesc(join(OUT, 'js'), jsFiles);
    const bundleFile = sorted[0];
    await copyStaticAssets(bundleFile);
    await pruneOldHashedAssets();

    if (isDev) console.log(`Dev build complete → ${bundleFile}`);
  }
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).padStart(8, '0').slice(0, 8);
}

main().catch((err) => { console.error(err); process.exit(1); });
