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

const inlineRule =
  /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\1(?=[\s?!.,:？!。,:]|$)/;
const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

interface MathToken {
  type: string;
  raw: string;
  text: string;
  displayMode: boolean;
}

function render(token: MathToken): string {
  const html = temml.renderToString(token.text, {
    displayMode: token.displayMode,
    throwOnError: false,
  });
  // Wrap block math in a <div> so Safari can apply overflow-x correctly.
  // Safari's overflow support on <math> elements is broken — long
  // equations escape the math box and push the parent's width, causing
  // page-level horizontal scroll. A plain <div> is reliable.
  if (token.displayMode) {
    return `<div class="math-block">${html}</div>`;
  }
  return html;
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
