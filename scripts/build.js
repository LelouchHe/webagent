#!/usr/bin/env node
// Build script: bundles frontend TS via esbuild, copies static assets to dist/.
// Usage: node scripts/build.js [--dev] [--watch]
//   --dev    Output to dist-dev/, no minification, no content hashing
//   --watch  Watch mode (implies --dev)

import { readFile, writeFile, cp, rm, readdir, watch as fsWatch } from 'node:fs/promises';
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

async function main() {
  await rm(OUT, { recursive: true, force: true });

  const esbuildOptions = {
    entryPoints: [join(SRC, 'js', 'app.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: join(OUT, 'js'),
    entryNames: isDev ? '[name]' : '[name].[hash]',
    minify: !isDev,
    external: ['marked', 'DOMPurify'],
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
    const bundleFile = jsFiles[0];
    await copyStaticAssets(bundleFile);

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
