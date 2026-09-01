import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("/view Enter dispatch", () => {
  let state: any;
  let dom: any;
  let viewer: typeof import("../public/js/file-viewer.ts");
  let handleSlashCommand: (text: string) => Promise<boolean>;
  let infoBody: Record<string, unknown>;
  let fetchCalls: string[];

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    viewer = await import("../public/js/file-viewer.ts");
    ({ handleSlashCommand } = await import("../public/js/slash-exec.ts"));
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    viewer.closeFileViewer();
    state.sessionCwd = "/work";
    fetchCalls = [];
    infoBody = {
      path: "/work/src",
      pathDisplay: "~/work/src",
      name: "src",
      kind: "dir",
      size: 0,
      mtime: 1,
    };
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      fetchCalls.push(url);
      if (url.startsWith("/api/v1/files/info?")) {
        return new Response(JSON.stringify(infoBody), { status: 200 });
      }
      return new Response("file body", { status: 200 });
    };
  });

  it("enters a directory and reopens the slash listing", async () => {
    const handled = await handleSlashCommand("/view src");

    assert.equal(handled, true);
    assert.equal(
      fetchCalls[0],
      `/api/v1/files/info?path=${encodeURIComponent("/work/src")}`,
    );
    assert.equal(dom.input.value, "/view ~/work/src/");
    assert.equal(dom.fileViewer.hidden, true);
  });

  it("opens a relative file directly in the viewer", async () => {
    infoBody = {
      path: "/work/notes.md",
      pathDisplay: "~/work/notes.md",
      name: "notes.md",
      kind: "file",
      size: 9,
      mtime: 1,
      mime: "text/plain",
      maxBytes: 1024,
      contentUrl: "/api/v1/files/content?path=x&exp=1&sig=s",
    };

    const handled = await handleSlashCommand("/view notes.md");

    assert.equal(handled, true);
    assert.equal(
      fetchCalls[0],
      `/api/v1/files/info?path=${encodeURIComponent("/work/notes.md")}`,
    );
    assert.equal(fetchCalls[1], infoBody.contentUrl);
    assert.equal(dom.fileViewer.hidden, false);
    assert.equal(dom.fileViewerPath.textContent, "~/work/notes.md");
    assert.match(dom.fileViewerContent.textContent, /file body/);
  });

  it("opens /view with no argument at the current cwd", async () => {
    infoBody = {
      path: "/work",
      pathDisplay: "~/work",
      name: "work",
      kind: "dir",
      size: 0,
      mtime: 1,
    };

    await handleSlashCommand("/view");

    assert.equal(
      fetchCalls[0],
      `/api/v1/files/info?path=${encodeURIComponent("/work")}`,
    );
    assert.equal(dom.input.value, "/view ~/work/");
  });
});
