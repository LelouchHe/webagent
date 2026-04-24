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

async function copyStaticAssets(bundles) {
  // bundles = { app: 'app.js' | 'app.<hash>.js', viewer: 'share/viewer.js' | 'share/viewer.<hash>.js' }
  // Copy static assets (everything except js/)
  for (const entry of await readdir(SRC)) {
    if (entry === 'js') continue;
    await cp(join(SRC, entry), join(OUT, entry), { recursive: true });
  }

  const rewriteHtml = async (name, bundle) => {
    const p = join(OUT, name);
    let html = await readFile(p, 'utf-8');
    html = html.replace('type="module" src="/js/app.js"', `src="/js/${bundle}"`);
    html = html.replace('type="module" src="/js/share/viewer.js"', `src="/js/${bundle}"`);
    await writeFile(p, html);
  };

  if (isDev) {
    // Dev: un-hashed bundles
    await rewriteHtml('index.html', bundles.app);
    // share-viewer.html has no inline script tag yet — inject one so dev+prod both work.
    const sv = join(OUT, 'share-viewer.html');
    let svHtml = await readFile(sv, 'utf-8');
    if (!svHtml.includes('src="/js/share/viewer')) {
      svHtml = svHtml.replace('</body>', `<script src="/js/${bundles.viewer}"></script>\n</body>`);
    }
    await writeFile(sv, svHtml);
  } else {
    // Production: hash CSS and rewrite HTML
    const cssFiles = [
      ['styles.css', 'index.html'],
      ['share-viewer.css', 'share-viewer.html'],
    ];
    const cssMap = {};
    for (const [cssName, _htmlName] of cssFiles) {
      const cssContent = await readFile(join(OUT, cssName), 'utf-8');
      const cssHash = hashString(cssContent);
      const hashedName = cssName.replace('.css', `.${cssHash}.css`);
      await writeFile(join(OUT, hashedName), cssContent);
      await rm(join(OUT, cssName));
      cssMap[cssName] = hashedName;
    }

    // index.html
    let html = await readFile(join(OUT, 'index.html'), 'utf-8');
    html = html.replace('/styles.css', `/${cssMap['styles.css']}`);
    html = html.replace('type="module" src="/js/app.js"', `src="/js/${bundles.app}"`);
    await writeFile(join(OUT, 'index.html'), html);

    // share-viewer.html — inject bundled script + rewrite CSS hrefs
    let svHtml = await readFile(join(OUT, 'share-viewer.html'), 'utf-8');
    svHtml = svHtml.replace('/styles.css', `/${cssMap['styles.css']}`);
    svHtml = svHtml.replace('/share-viewer.css', `/${cssMap['share-viewer.css']}`);
    if (!svHtml.includes('src="/js/share/viewer')) {
      svHtml = svHtml.replace('</body>', `<script src="/js/${bundles.viewer}"></script>\n</body>`);
    }
    await writeFile(join(OUT, 'share-viewer.html'), svHtml);

    console.log(`Build complete → app=${bundles.app}, viewer=${bundles.viewer}`);
  }
}

async function main() {
  await rm(OUT, { recursive: true, force: true });

  const esbuildOptions = {
    entryPoints: [
      join(SRC, 'js', 'app.ts'),
      join(SRC, 'js', 'share', 'viewer.ts'),
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: join(OUT, 'js'),
    entryNames: isDev ? '[name]' : '[name].[hash]',
    minify: !isDev,
    // Main app loads marked/DOMPurify from CDN for now. Share viewer MUST
    // bundle them (no CDN, strict CSP). esbuild picks them up from node_modules
    // for viewer.ts; keeping them external for app.ts preserves current
    // CDN behavior until the main app is migrated off CDN separately.
    external: [],
    alias: {},
  };

  if (isWatch) {
    const ctx = await context(esbuildOptions);
    await ctx.watch();
    // Initial build
    await ctx.rebuild();
    await copyStaticAssets({ app: 'app.js', viewer: 'share/viewer.js' });
    console.log(`Dev build ready (watching for changes)…`);

    // Also watch static assets (HTML, CSS) for changes
    const ac = new AbortController();
    (async () => {
      try {
        const watcher = fsWatch(SRC, { recursive: true, signal: ac.signal });
        for await (const event of watcher) {
          if (event.filename && !event.filename.startsWith('js/')) {
            await copyStaticAssets({ app: 'app.js', viewer: 'share/viewer.js' });
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      }
    })();

    process.on('SIGINT', () => { ac.abort(); ctx.dispose(); });
  } else {
    await build(esbuildOptions);

    // esbuild flattens entry names: viewer.ts -> js/viewer.[hash].js.
    const topFiles = (await readdir(join(OUT, 'js'))).filter(f => f.endsWith('.js'));
    const appBundle = topFiles.find(f => f.startsWith('app')) ?? 'app.js';
    const viewerBundle = topFiles.find(f => f.startsWith('viewer')) ?? 'viewer.js';
    await copyStaticAssets({ app: appBundle, viewer: viewerBundle });

    if (isDev) console.log(`Dev build complete → app=${appBundle}, viewer=${viewerBundle}`);
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
