// Lazy-loaded syntax highlighting (highlight.js) + code block toolbar (language label + copy button)

type LoadState = 'idle' | 'loading' | 'ready';
let hljsState: LoadState = 'idle';
let hljsResolvers: Array<() => void> = [];

const HLJS_VERSION = '11.11.1';
const HLJS_CDN = `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@${HLJS_VERSION}/build`;

// Theme mapping: data-theme → hljs theme CSS file
const HLJS_THEMES: Record<string, string> = {
  dark: 'github-dark.min.css',
  light: 'github.min.css',
  auto: '', // resolved at runtime
};

let themeLink: HTMLLinkElement | null = null;

function resolvedTheme(): 'dark' | 'light' {
  const t = document.documentElement.getAttribute('data-theme') || 'auto';
  if (t === 'light') return 'light';
  if (t === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function loadThemeCSS() {
  const theme = resolvedTheme();
  const file = HLJS_THEMES[theme];
  const href = `${HLJS_CDN}/styles/${file}`;

  if (themeLink) {
    if (themeLink.href === href) return;
    themeLink.href = href;
    return;
  }
  themeLink = document.createElement('link');
  themeLink.rel = 'stylesheet';
  themeLink.href = href;
  document.head.appendChild(themeLink);
}

function loadHljsScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${HLJS_CDN}/highlight.min.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load highlight.js'));
    document.head.appendChild(script);
  });
}

async function ensureHljs(): Promise<boolean> {
  if (hljsState === 'ready') return true;
  if (hljsState === 'loading') {
    return new Promise<boolean>(resolve => {
      hljsResolvers.push(() => resolve(hljsState === 'ready'));
    });
  }

  hljsState = 'loading';
  try {
    loadThemeCSS();
    await loadHljsScript();
    hljsState = 'ready';
    const waiters = hljsResolvers.splice(0);
    waiters.forEach(r => r());
    return true;
  } catch {
    hljsState = 'idle'; // allow retry
    const waiters = hljsResolvers.splice(0);
    waiters.forEach(r => r());
    return false;
  }
}

function highlightAllIn(container: Element) {
  const hljs = (globalThis as { hljs?: { highlightElement: (el: Element) => void } }).hljs;
  if (!hljs) return;
  for (const code of container.querySelectorAll('pre code')) {
    if (!(code as HTMLElement).dataset.highlighted) {
      hljs.highlightElement(code);
    }
  }
}

// --- Code block toolbar (language label + copy button) ---

function extractLanguage(code: Element): string {
  for (const cls of code.classList) {
    if (cls.startsWith('language-')) return cls.slice(9);
  }
  return '';
}

/** Wrap each <pre><code> with a toolbar (language label + copy button). */
export function processCodeBlocks(container: Element) {
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    const code = pre.querySelector('code');
    if (!code) continue;
    // Skip already processed
    if (pre.parentElement?.classList.contains('code-block-wrapper')) continue;

    const lang = extractLanguage(code);

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'cp';
    copyBtn.type = 'button';
    toolbar.appendChild(copyBtn);

    pre.replaceWith(wrapper);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(pre);
  }
}

// --- Copy button ---

const copyTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

/** Copy button click handler — delegated from #messages */
export function handleCopyClick(e: Event) {
  const btn = (e.target as Element).closest('.copy-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const wrapper = btn.closest('.code-block-wrapper');
  const code = wrapper?.querySelector('code');
  if (!code) return;

  const text = code.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    // Reset any pending timer from a previous click
    const prev = copyTimers.get(btn);
    if (prev) clearTimeout(prev);

    btn.textContent = '✓';
    btn.classList.add('copied');
    const timer = setTimeout(() => {
      btn.textContent = 'cp';
      btn.classList.remove('copied');
      copyTimers.delete(btn);
    }, 1500);
    copyTimers.set(btn, timer);
  }).catch(() => {
    // Fallback: select text
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

/**
 * Process code blocks in a container: add toolbar + trigger lazy highlight.
 * Called after renderMd() sets innerHTML.
 */
export async function enhanceCodeBlocks(container: Element) {
  const hasCode = container.querySelector('pre code');
  if (!hasCode) return;

  processCodeBlocks(container);

  const loaded = await ensureHljs();
  if (loaded) {
    highlightAllIn(container);
  }
}

/** Call when theme changes to swap hljs CSS */
export function onThemeChange() {
  if (hljsState === 'ready' && themeLink) {
    loadThemeCSS();
  }
}

// Listen for OS color scheme changes (affects 'auto' theme)
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (hljsState === 'ready' && themeLink) {
      loadThemeCSS();
    }
  });
}
