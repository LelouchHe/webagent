import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("slash-render — renderItem", () => {
  let renderItem: typeof import("../public/js/slash-render.ts").renderItem;

  before(async () => {
    setupDOM();
    ({ renderItem } = await import("../public/js/slash-render.ts"));
  });
  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
  });

  function txt(el: HTMLElement): string {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- el.textContent could be null
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  it("single-line: primary only", () => {
    const el = renderItem({ primary: "/help" }, false, "");
    assert.equal(el.classList.contains("slash-item"), true);
    assert.equal(el.classList.contains("selected"), false);
    assert.match(txt(el), /\/help/);
    // No L2 row when no path
    assert.equal(el.querySelector(".slash-row-l2"), null);
    // L1 exists
    assert.ok(el.querySelector(".slash-row-l1"));
  });

  it("single-line: primary + secondary", () => {
    const el = renderItem(
      { primary: "/help", secondary: "Show help" },
      false,
      "",
    );
    const sec = el.querySelector(".slash-secondary");
    assert.ok(sec);
    assert.equal((sec as HTMLElement).textContent, "Show help");
  });

  it("double-line: path triggers L2", () => {
    const el = renderItem(
      {
        primary: "feature/foo",
        secondary: "2 hours ago",
        path: "/long/path/to/repo",
      },
      false,
      "",
    );
    assert.ok(el.querySelector(".slash-row-l2"));
    const path = el.querySelector(".slash-path");
    assert.ok(path);
    assert.equal((path as HTMLElement).textContent, "/long/path/to/repo");
  });

  it("double-line: path + pathSecondary", () => {
    const el = renderItem(
      {
        primary: "msg",
        path: "/cwd",
        pathSecondary: "from-bot",
      },
      false,
      "",
    );
    const ps = el.querySelector(".slash-path-secondary");
    assert.ok(ps);
    assert.equal((ps as HTMLElement).textContent, "from-bot");
  });

  it("selected adds .selected class", () => {
    const el = renderItem({ primary: "/x" }, true, "");
    assert.equal(el.classList.contains("selected"), true);
  });

  it("current=true marks .slash-current on primary (walker passes prefix=*)", () => {
    const el = renderItem({ primary: "gpt-5", current: true }, false, "*");
    const primary = el.querySelector(".slash-primary");
    assert.ok(primary);
    assert.equal(primary.classList.contains("slash-current"), true);
    const prefix = el.querySelector(".slash-prefix");
    assert.equal((prefix as HTMLElement).textContent, "*");
  });

  it("prefix='›' renders chevron", () => {
    const el = renderItem({ primary: "ack" }, false, "›");
    const prefix = el.querySelector(".slash-prefix");
    assert.equal((prefix as HTMLElement).textContent, "›");
    // Not green unless current
    const primary = el.querySelector(".slash-primary");
    assert.equal(primary?.classList.contains("slash-current"), false);
  });

  it("prefix='' leaves prefix slot empty (still occupies width)", () => {
    const el = renderItem({ primary: "foo" }, false, "");
    const prefix = el.querySelector(".slash-prefix");
    assert.ok(prefix);
    assert.equal((prefix as HTMLElement).textContent, "");
  });

  it("escapes HTML in primary / secondary / path", () => {
    const el = renderItem(
      {
        primary: "<script>",
        secondary: "<img src=x>",
        path: "<b>",
        pathSecondary: "</b>",
      },
      false,
      "",
    );
    // Should not introduce real <script> elements
    assert.equal(el.querySelector("script"), null);
    assert.equal(el.querySelector("img"), null);
    // Text content preserved literally
    const primary = el.querySelector(".slash-primary") as HTMLElement;
    assert.equal(primary.textContent, "<script>");
  });
});
