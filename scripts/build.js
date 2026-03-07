#!/usr/bin/env node
// Build script: copies public/ → dist/, adds a timestamp to JS/CSS filenames.

import { readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';

const SRC = 'public';
const OUT = 'dist';
const stamp = Date.now().toString(36);

async function build() {
  await rm(OUT, { recursive: true, force: true });
  await cp(SRC, OUT, { recursive: true });

  const jsDir = join(OUT, 'js');
  const jsFiles = (await readdir(jsDir)).filter(f => f.endsWith('.js'));

  // Rewrite imports in JS files: './foo.js' → './foo.STAMP.js'
  for (const file of jsFiles) {
    let content = await readFile(join(jsDir, file), 'utf-8');
    for (const f of jsFiles) {
      content = content.replaceAll(`./${f}`, `./${basename(f, '.js')}.${stamp}.js`);
    }
    await writeFile(join(jsDir, `${basename(file, '.js')}.${stamp}.js`), content);
    await rm(join(jsDir, file));
  }

  // Rename CSS
  const newCss = `styles.${stamp}.css`;
  await cp(join(OUT, 'styles.css'), join(OUT, newCss));
  await rm(join(OUT, 'styles.css'));

  // Rewrite index.html
  let html = await readFile(join(OUT, 'index.html'), 'utf-8');
  html = html.replace('/styles.css', `/${newCss}`);
  html = html.replace('/js/app.js', `/js/app.${stamp}.js`);
  await writeFile(join(OUT, 'index.html'), html);

  console.log(`Build complete (stamp: ${stamp})`);
}

build().catch((err) => { console.error(err); process.exit(1); });
