// Read-only file viewer. Mobile uses a full-screen overlay; desktop reserves a
// right-hand pane via scoped CSS. The module renders only sanitized Markdown,
// escaped text/code, images, or a download fallback — never executable HTML.

import * as api from "./api.ts";
import { dom } from "./state.ts";
import { updateMarkdownStream } from "./markdown-stream.ts";
import { enhanceCodeBlocks, highlightCodeElement } from "./highlight.ts";
import { MAX_TEXT_PREVIEW_BYTES } from "../../src/files/limits.ts";

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
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }

  // Keep only a small batch of number strings live at once. The final gutter
  // is still one text node, but a newline-dense file no longer creates an
  // array containing hundreds of thousands of individual strings.
  const chunks: string[] = [];
  let batch: string[] = [];
  for (let line = 1; line <= count; line++) {
    batch.push(String(line));
    if (batch.length === 1024) {
      chunks.push(batch.join("\n"));
      batch = [];
    }
  }
  if (batch.length > 0) chunks.push(batch.join("\n"));
  return chunks.join("\n");
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

  await highlightCodeElement(code, LANGUAGE_BY_EXTENSION[extension(name)]);
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

function triggerDownload(info: api.FileInfo): void {
  const link = document.createElement("a");
  link.href = info.contentUrl!;
  link.download = info.name;
  // Open in a new tab so the PWA's own page is never navigated into the
  // attachment/download response. Without `target="_blank"` the hidden click
  // navigates the current standalone window to the content URL, where there
  // is no address bar or back button to return from (a dead-end that forces
  // the user to kill and reopen the PWA). Matches the attachment bubbles in
  // render-event.ts / input.ts.
  link.target = "_blank";
  link.rel = "noopener";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function isPreviewable(info: api.FileInfo, mime: string): boolean {
  if (mime.startsWith("text/")) {
    return info.size <= MAX_TEXT_PREVIEW_BYTES;
  }
  if (mime.startsWith("image/")) {
    return info.maxBytes !== undefined && info.size <= info.maxBytes;
  }
  return false;
}

async function fetchText(contentUrl: string): Promise<Response> {
  return api.withTimeout((signal) =>
    fetch(contentUrl, signal ? { signal } : undefined),
  );
}

async function switchFetchToDownload(
  response: Response,
  info: api.FileInfo,
  generation: number,
): Promise<boolean> {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const responseMime =
    response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!/^attachment\b/i.test(disposition) && responseMime.startsWith("text/")) {
    return false;
  }
  await response.body?.cancel();
  if (generation !== openGeneration) return true;
  closeFileViewer();
  triggerDownload(info);
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
    if (await switchFetchToDownload(response, info, generation)) return;
    const text = await response.text();
    if (generation !== openGeneration) return;

    clearContent();
    if (isMarkdown(info.name)) {
      renderMarkdown(text);
    } else {
      await renderCode(text, info.name);
      if (generation !== openGeneration) return;
    }
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
  if (info.kind !== "file") {
    showShell(info.pathDisplay ?? info.path);
    showNotice("Not a regular file");
    return;
  }
  if (!info.contentUrl) {
    showShell(info.pathDisplay ?? info.path);
    showNotice("File content is temporarily unavailable");
    return;
  }

  const mime = info.mime?.toLowerCase() ?? "application/octet-stream";
  if (!isPreviewable(info, mime)) {
    closeFileViewer();
    triggerDownload(info);
    return;
  }

  const generation = showShell(info.pathDisplay ?? info.path);
  if (mime.startsWith("image/")) {
    renderImage(info);
    return;
  }
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
