// LaTeX math rendering via Temml (LaTeX → MathML).
//
// Why Temml not KaTeX:
//   - KaTeX uses inline style attributes (top: -3em etc) for vlist positioning,
//     which our CSP `style-src 'self'` blocks → broken layout. Adding `'unsafe-inline'`
//     would weaken defense-in-depth permanently.
//   - Temml emits pure MathML: browser-native rendering, no inline-style
//     hacks, no CSP changes needed.
//   - Smaller bundle (~150KB vs ~280KB), one font (Temml.woff2 ~9KB) vs 20.
//
// Side-effect import: importing this module registers the marked extension.
// render-event.ts imports it once at module load time so $...$ tokens are
// recognized for all subsequent marked.parse() calls.
//
// Math regex patterns are lifted from marked-katex-extension (proven across
// many edge cases: prices like "$5 and $10" don't match, "\$" escapes work,
// punctuation/CJK after closing $ is allowed).

import { marked } from "marked";
import temml from "temml";

// Boundary lookahead intentionally includes BOTH ASCII (?!.,:) AND CJK
// fullwidth (？！。，：) punctuation — verbatim from upstream
// marked-katex-extension. Past drift here (ASCII !,: had silently replaced
// fullwidth ！，： due to homoglyph copy-paste) caused `$x$，` / `$x$：` /
// `$x$！` to fail to render. Do not collapse the duplicates.
const inlineRule =
  /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\1(?=[\s?!.,:？！。，：]|$)/;
const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

interface MathToken {
  type: string;
  raw: string;
  text: string;
  displayMode: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render(token: MathToken): string {
  // throwOnError: true so we can intercept failures and degrade gracefully
  // to the literal source instead of letting Temml emit its red inline
  // error message — those errors break paragraph flow and pollute any
  // copy/paste of the conversation.
  let html: string;
  try {
    html = temml.renderToString(token.text, {
      displayMode: token.displayMode,
      throwOnError: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const literal = escapeHtml(token.raw);
    const title = escapeHtml(`LaTeX parse error: ${message}`);
    const span = `<span class="math-error" title="${title}">${literal}</span>`;
    if (token.displayMode) {
      return `<div class="math-block">${span}</div>`;
    }
    return span;
  }
  // Wrap block math in a <div> so Safari can apply overflow-x correctly.
  // Safari's overflow support on <math> elements is broken — long
  // equations escape the math box and push the parent's width, causing
  // page-level horizontal scroll. A plain <div> is reliable.
  if (token.displayMode) {
    return `<div class="math-block">${html}</div>`;
  }
  // Same Safari quirk applies to inline <math>: applying max-width /
  // overflow-x directly on <math> doesn't constrain it on iOS, so a long
  // inline formula pushes the page width and lets the whole page scroll
  // horizontally. Wrapping in an inline-block <span> gives us a real box
  // that respects max-width and provides a per-formula scrollbar without
  // affecting page width or surrounding text flow.
  return `<span class="math-inline">${html}</span>`;
}

const inlineMath = {
  name: "inlineMath",
  level: "inline" as const,
  start(src: string): number | undefined {
    let index;
    let indexSrc = src;
    while (indexSrc) {
      index = indexSrc.indexOf("$");
      if (index === -1) return undefined;
      const f = index === 0 || indexSrc.charAt(index - 1) === " ";
      if (f) {
        const possible = indexSrc.substring(index);
        if (inlineRule.exec(possible)) return index;
      }
      indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, "");
    }
    return undefined;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = inlineRule.exec(src);
    if (match) {
      return {
        type: "inlineMath",
        raw: match[0],
        text: match[2].trim(),
        displayMode: match[1].length === 2,
      };
    }
    return undefined;
  },
  renderer: render,
};

const blockMath = {
  name: "blockMath",
  level: "block" as const,
  tokenizer(src: string): MathToken | undefined {
    const match = blockRule.exec(src);
    if (match) {
      return {
        type: "blockMath",
        raw: match[0],
        text: match[2].trim(),
        displayMode: match[1].length === 2,
      };
    }
    return undefined;
  },
  renderer: (token: MathToken) => render(token) + "\n",
};

marked.use({ extensions: [inlineMath, blockMath] });
