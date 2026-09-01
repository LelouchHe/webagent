import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import type { FileInfo } from "../public/js/api.ts";
import { MAX_TEXT_PREVIEW_BYTES } from "../src/files/limits.ts";

describe("file viewer frontend", () => {
  let state: any;
  let dom: any;
  let viewer: typeof import("../public/js/file-viewer.ts");
  let response: Response;
  let fetchCalls: string[];
  let downloads: string[];

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    viewer = await import("../public/js/file-viewer.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    viewer.closeFileViewer();
    fetchCalls = [];
    downloads = [];
    window.HTMLAnchorElement.prototype.click = function () {
      downloads.push(this.getAttribute("href") ?? "");
    };
    response = new Response("", { status: 200 });
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      fetchCalls.push(url);
      return response;
    };
  });

  function info(overrides: Partial<FileInfo> = {}): FileInfo {
    return {
      path: "/tmp/file.txt",
      name: "file.txt",
      kind: "file",
      size: 4,
      mtime: 1,
      mime: "text/plain",
      maxBytes: MAX_TEXT_PREVIEW_BYTES,
      contentUrl: "/api/v1/files/content?path=x&exp=1&sig=s",
      ...overrides,
    };
  }

  it("renders Markdown through the existing sanitized pipeline", async () => {
    response = new Response("# Heading\n\nhello", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });

    await viewer.openFileInfo(
      info({
        path: "/Users/me/readme.md",
        pathDisplay: "~/readme.md",
        name: "readme.md",
      }),
    );

    assert.equal(dom.fileViewer.hidden, false);
    assert.equal(dom.fileViewerPath.textContent, "~/readme.md");
    assert.equal(
      dom.fileViewerContent.querySelector("h1")?.textContent,
      "Heading",
    );
    assert.match(dom.fileViewerContent.textContent, /hello/);
  });

  it("renders code as text with a separate line-number column", async () => {
    response = new Response("const x = 1;\nconsole.log(x);", { status: 200 });

    await viewer.openFileInfo(info({ path: "/tmp/demo.ts", name: "demo.ts" }));

    assert.equal(
      dom.fileViewerContent.querySelector("code")?.textContent,
      "const x = 1;\nconsole.log(x);",
    );
    assert.equal(
      dom.fileViewerContent.querySelector(".file-viewer-line-numbers")
        ?.textContent,
      "1\n2",
    );
  });

  it("renders images directly from the signed URL without fetching bytes", async () => {
    const contentUrl = "/api/v1/files/content?path=img&exp=1&sig=s";

    await viewer.openFileInfo(
      info({
        path: "/tmp/p.png",
        name: "p.png",
        mime: "image/png",
        contentUrl,
      }),
    );

    const img = dom.fileViewerContent.querySelector("img");
    assert.ok(img);
    assert.match(img.src, /\/api\/v1\/files\/content\?path=img/);
    assert.equal(fetchCalls.length, 0);
  });

  it("directly downloads unknown binaries without opening the viewer", async () => {
    const contentUrl = "/api/v1/files/content?path=zip&exp=1&sig=s";

    await viewer.openFileInfo(
      info({
        path: "/tmp/archive.zip",
        name: "archive.zip",
        mime: "application/zip",
        maxBytes: undefined,
        contentUrl,
      }),
    );

    assert.deepEqual(downloads, [contentUrl]);
    assert.equal(dom.fileViewer.hidden, true);
    assert.equal(fetchCalls.length, 0);
  });

  it("directly downloads text over the shared 1 MiB preview cap", async () => {
    const contentUrl = "/api/v1/files/content?path=large&exp=1&sig=s";

    await viewer.openFileInfo(
      info({ size: MAX_TEXT_PREVIEW_BYTES + 1, contentUrl }),
    );

    assert.deepEqual(downloads, [contentUrl]);
    assert.equal(dom.fileViewer.hidden, true);
    assert.equal(fetchCalls.length, 0);
  });

  it("switches a stale text preview response to download on attachment", async () => {
    const contentUrl = "/api/v1/files/content?path=changed&exp=1&sig=s";
    response = new Response("changed after info", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": "attachment; filename=changed.txt",
      },
    });

    await viewer.openFileInfo(info({ contentUrl }));

    assert.deepEqual(downloads, [contentUrl]);
    assert.equal(dom.fileViewer.hidden, true);
    assert.equal(fetchCalls.length, 1);
  });

  it("close button exits the viewer and restores the page layout", async () => {
    response = new Response("text", { status: 200 });
    await viewer.openFileInfo(info());
    assert.equal(document.body.classList.contains("file-viewer-open"), true);

    dom.fileViewerClose.click();

    assert.equal(dom.fileViewer.hidden, true);
    assert.equal(document.body.classList.contains("file-viewer-open"), false);
    assert.equal(dom.fileViewerContent.textContent, "");
  });
});
