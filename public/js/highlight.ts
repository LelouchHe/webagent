// Syntax highlighting (highlight.js, common 36 languages, lazy-loaded)
// + code block toolbar (language label + copy button)
//
// hljs is dynamically imported into a separate chunk (esbuild splitting:true).
// `<link rel="modulepreload">` in index.html starts the chunk download in
// parallel with app.js, so by the time the first code block lands the chunk
// is usually warm in cache. enhanceCodeBlocks renders the toolbar
// synchronously; highlightAllIn awaits the dynamic import. Theme CSS is
// appended to the main styles bundle at build time (see scripts/build.js).

let hljsPromise: Promise<
  typeof import("highlight.js/lib/common").default
> | null = null;
const getHljs = () =>
  (hljsPromise ??= import("highlight.js/lib/common").then((m) => m.default));

async function highlightAllIn(container: Element) {
  const hljs = await getHljs();
  for (const code of container.querySelectorAll("pre code")) {
    if (!(code as HTMLElement).dataset.highlighted) {
      hljs.highlightElement(code as HTMLElement);
    }
  }
}

// --- Code block toolbar (copy button) ---

/** Wrap each <pre><code> with a toolbar (copy button). */
export function processCodeBlocks(container: Element) {
  const pres = container.querySelectorAll("pre");
  for (const pre of pres) {
    const code = pre.querySelector("code");
    if (!code) continue;
    if (pre.parentElement?.classList.contains("code-block-wrapper")) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "cp";
    copyBtn.type = "button";
    toolbar.appendChild(copyBtn);

    pre.replaceWith(wrapper);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(pre);
  }
}

// --- Copy button ---

const copyTimers = new WeakMap<
  HTMLButtonElement,
  ReturnType<typeof setTimeout>
>();

/** Copy button click handler — delegated from #messages */
export function handleCopyClick(e: Event) {
  const btn = (e.target as Element).closest(".copy-btn");
  if (!btn) return;

  const wrapper = btn.closest(".code-block-wrapper");
  const code = wrapper?.querySelector("code");
  if (!code) return;

  const text = code.textContent || "";
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const prev = copyTimers.get(btn);
      if (prev) clearTimeout(prev);

      btn.textContent = "✓";
      btn.classList.add("copied");
      const timer = setTimeout(() => {
        btn.textContent = "cp";
        btn.classList.remove("copied");
        copyTimers.delete(btn);
      }, 1500);
      copyTimers.set(btn, timer);
    })
    .catch(() => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
}

/**
 * Process code blocks in a container: add toolbar synchronously, then
 * highlight asynchronously (chunk loads on demand, hits modulepreload cache).
 */
export function enhanceCodeBlocks(container: Element) {
  if (!container.querySelector("pre code")) return;
  processCodeBlocks(container);
  void highlightAllIn(container);
}

/**
 * Theme change is handled entirely in CSS now (see styles.css / hljs theme
 * blocks scoped by [data-theme] + prefers-color-scheme). This is kept as a
 * no-op for backward compat with app.ts wiring.
 */
export function onThemeChange() {
  // intentionally empty
}
