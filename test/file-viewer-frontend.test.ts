import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import type { FileInfo } from "../public/js/api.ts";

describe("file viewer frontend", () => {
  let state: any;
  let dom: any;
  let viewer: typeof import("../public/js/file-viewer.ts");
  let response: Response;
  let fetchCalls: string[];

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
      maxBytes: 4 * 1024 * 1024,
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
      info({ path: "/tmp/readme.md", name: "readme.md" }),
    );

    assert.equal(dom.fileViewer.hidden, false);
    assert.equal(dom.fileViewerPath.textContent, "/tmp/readme.md");
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

  it("does not fetch unknown binaries and offers download only", async () => {
    const contentUrl = "/api/v1/files/content?path=zip&exp=1&sig=s";

    await viewer.openFileInfo(
      info({
        path: "/tmp/archive.zip",
        name: "archive.zip",
        mime: "application/zip",
        contentUrl,
      }),
    );

    const link = dom.fileViewerContent.querySelector(
      "a[download]",
    ) as HTMLAnchorElement | null;
    assert.ok(link);
    assert.equal(link.getAttribute("href"), contentUrl);
    assert.equal(fetchCalls.length, 0);
  });

  it("does not offer a download that exceeds the server cap", async () => {
    await viewer.openFileInfo(
      info({
        path: "/tmp/huge.zip",
        name: "huge.zip",
        mime: "application/zip",
        size: 200,
        maxBytes: 100,
      }),
    );

    assert.equal(
      Boolean(dom.fileViewerContent.querySelector("a[download]")),
      false,
    );
    assert.match(dom.fileViewerNotice.textContent, /exceeds/i);
  });

  it("shows server truncation without dropping rendered text", async () => {
    response = new Response("partial", {
      status: 200,
      headers: { "X-File-Truncated": "1" },
    });

    await viewer.openFileInfo(info());

    assert.match(dom.fileViewerContent.textContent, /partial/);
    assert.match(dom.fileViewerNotice.textContent, /truncated/i);
    assert.equal(dom.fileViewerNotice.hidden, false);
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
