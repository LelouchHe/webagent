// Read-only file viewer. Mobile uses a full-screen overlay; desktop reserves a
// right-hand pane via scoped CSS. The module renders only sanitized Markdown,
// escaped text/code, images, or a download fallback — never executable HTML.

import * as api from "./api.ts";
import { dom } from "./state.ts";
import { updateMarkdownStream } from "./markdown-stream.ts";
import { enhanceCodeBlocks, highlightCodeElement } from "./highlight.ts";

const MAX_HIGHLIGHT_CHARS = 512 * 1024;
const MAX_RICH_MARKDOWN_CHARS = 1024 * 1024;

let openGeneration = 0;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  lua: "lua",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function clearContent(): void {
  dom.fileViewerContent.replaceChildren();
  dom.fileViewerNotice.textContent = "";
  dom.fileViewerNotice.hidden = true;
}

function showNotice(text: string): void {
  dom.fileViewerNotice.textContent = text;
  dom.fileViewerNotice.hidden = false;
}

function showShell(path: string): number {
  const generation = ++openGeneration;
  clearContent();
  dom.fileViewerPath.textContent = path;
  dom.fileViewer.hidden = false;
  document.body.classList.add("file-viewer-open");
  return generation;
}

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function isMarkdown(name: string): boolean {
  const ext = extension(name);
  return ext === "md" || ext === "markdown";
}

function lineNumbers(text: string): string {
  const count = text.split("\n").length;
  return Array.from({ length: count }, (_, i) => String(i + 1)).join("\n");
}

async function renderCode(text: string, name: string): Promise<void> {
  const scroll = document.createElement("div");
  scroll.className = "file-viewer-code-scroll";

  const grid = document.createElement("div");
  grid.className = "file-viewer-code-grid";

  const numbers = document.createElement("pre");
  numbers.className = "file-viewer-line-numbers";
  numbers.setAttribute("aria-hidden", "true");
  numbers.textContent = lineNumbers(text);

  const pre = document.createElement("pre");
  pre.className = "file-viewer-code";
  const code = document.createElement("code");
  code.textContent = text;
  pre.appendChild(code);

  grid.append(numbers, pre);
  scroll.appendChild(grid);
  dom.fileViewerContent.appendChild(scroll);

  if (text.length <= MAX_HIGHLIGHT_CHARS) {
    await highlightCodeElement(code, LANGUAGE_BY_EXTENSION[extension(name)]);
  }
}

function renderMarkdown(text: string): void {
  const article = document.createElement("article");
  // Reuse the existing assistant Markdown styles without widening their base
  // selectors; viewer-only adjustments remain scoped to this class in CSS.
  article.className = "file-viewer-markdown msg assistant";
  dom.fileViewerContent.appendChild(article);
  updateMarkdownStream(article, text);
  enhanceCodeBlocks(article);
}

function renderImage(info: api.FileInfo): void {
  const img = document.createElement("img");
  img.className = "file-viewer-image";
  img.src = info.contentUrl!;
  img.alt = info.name;
  dom.fileViewerContent.appendChild(img);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderDownload(info: api.FileInfo, downloadable = true): void {
  const meta = document.createElement("p");
  meta.className = "file-viewer-binary-meta";
  meta.textContent = `${info.mime ?? "application/octet-stream"} · ${formatBytes(info.size)}`;

  dom.fileViewerContent.appendChild(meta);
  if (!downloadable) return;

  const link = document.createElement("a");
  link.className = "file-viewer-download";
  link.href = info.contentUrl!;
  link.download = info.name;
  link.textContent = "Download";
  dom.fileViewerContent.appendChild(link);
}

async function fetchText(contentUrl: string): Promise<Response> {
  return api.withTimeout((signal) =>
    fetch(contentUrl, signal ? { signal } : undefined),
  );
}

function renderNonText(info: api.FileInfo, mime: string): boolean {
  if (mime.startsWith("text/")) return false;
  if (info.maxBytes !== undefined && info.size > info.maxBytes) {
    renderDownload(info, false);
    showNotice("File exceeds the preview/download limit");
  } else if (mime.startsWith("image/")) {
    renderImage(info);
  } else {
    renderDownload(info);
  }
  return true;
}

async function renderTextFile(
  info: api.FileInfo,
  generation: number,
): Promise<void> {
  showNotice("Loading…");
  try {
    const response = await fetchText(info.contentUrl!);
    if (generation !== openGeneration) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (generation !== openGeneration) return;

    clearContent();
    const truncated = response.headers.get("X-File-Truncated") === "1";
    if (isMarkdown(info.name) && text.length <= MAX_RICH_MARKDOWN_CHARS) {
      renderMarkdown(text);
    } else {
      await renderCode(text, info.name);
      if (generation !== openGeneration) return;
      if (isMarkdown(info.name)) {
        showNotice("Large Markdown shown as plain text");
      }
    }
    if (truncated) showNotice("File truncated to the preview limit");
  } catch (err) {
    if (generation !== openGeneration) return;
    clearContent();
    showNotice(
      `Unable to load file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Open a metadata-confirmed regular file in the responsive viewer. */
export async function openFileInfo(info: api.FileInfo): Promise<void> {
  const generation = showShell(info.pathDisplay ?? info.path);
  if (info.kind !== "file") {
    showNotice("Not a regular file");
    return;
  }
  if (!info.contentUrl) {
    showNotice("File content is temporarily unavailable");
    return;
  }

  const mime = info.mime?.toLowerCase() ?? "application/octet-stream";
  if (renderNonText(info, mime)) return;
  await renderTextFile(info, generation);
}

export function closeFileViewer(): void {
  ++openGeneration;
  clearContent();
  dom.fileViewerPath.textContent = "";
  dom.fileViewer.hidden = true;
  document.body.classList.remove("file-viewer-open");
}

export function isFileViewerOpen(): boolean {
  return !dom.fileViewer.hidden;
}

dom.fileViewerClose.addEventListener("click", closeFileViewer);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !isFileViewerOpen()) return;
  event.preventDefault();
  closeFileViewer();
});
