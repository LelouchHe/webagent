import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fileFilter,
  joinListedPath,
  resolveBrowseTarget,
} from "../public/js/file-browser.ts";

describe("file browser path resolution", () => {
  it("starts an empty /view query at the session cwd", () => {
    assert.deepEqual(resolveBrowseTarget("", "/work/project"), {
      directory: "/work/project",
      filter: "",
    });
  });

  it("resolves relative input against the session cwd", () => {
    assert.deepEqual(resolveBrowseTarget("src/comp", "/work/project"), {
      directory: "/work/project/src",
      filter: "comp",
    });
  });

  it("splits absolute input into directory + live filter", () => {
    assert.deepEqual(resolveBrowseTarget("/etc/hos", "/ignored"), {
      directory: "/etc",
      filter: "hos",
    });
  });

  it("treats a trailing slash as an entered directory", () => {
    assert.deepEqual(resolveBrowseTarget("/work/project/src/", "/ignored"), {
      directory: "/work/project/src/",
      filter: "",
    });
  });

  it("handles root and home prefixes", () => {
    assert.deepEqual(resolveBrowseTarget("/", "/ignored"), {
      directory: "/",
      filter: "",
    });
    assert.deepEqual(resolveBrowseTarget("~", "/ignored"), {
      directory: "~",
      filter: "",
    });
    assert.deepEqual(resolveBrowseTarget("~/Doc", "/ignored"), {
      directory: "~",
      filter: "Doc",
    });
  });

  it("normalizes Windows display paths without expanding HOME", () => {
    assert.equal(
      resolveBrowseTarget("~\\mine\\code\\file.ts", null).directory,
      "~/mine/code",
    );
    assert.deepEqual(
      resolveBrowseTarget("C:\\Users\\me\\project\\file.ts", null),
      {
        directory: "C:/Users/me/project",
        filter: "file.ts",
      },
    );
    assert.deepEqual(
      resolveBrowseTarget("\\\\server\\share\\dir\\file.ts", null),
      {
        directory: "//server/share/dir",
        filter: "file.ts",
      },
    );
    assert.deepEqual(resolveBrowseTarget("", "C:\\Users\\me\\project"), {
      directory: "C:/Users/me/project",
      filter: "",
    });
  });

  it("rejects a relative query without a session cwd", () => {
    assert.throws(() => resolveBrowseTarget("src", null), /active session/i);
  });

  it("extracts the current segment for local filtering", () => {
    assert.equal(fileFilter("/work/src/serv"), "serv");
    assert.equal(fileFilter("/work/src/"), "");
    assert.equal(fileFilter("~"), "");
    assert.equal(fileFilter(".."), "..");
  });

  it("joins listed names without producing a double root slash", () => {
    assert.equal(joinListedPath("/", "etc"), "/etc");
    assert.equal(
      joinListedPath("/work/project", "a b.md"),
      "/work/project/a b.md",
    );
  });
});
