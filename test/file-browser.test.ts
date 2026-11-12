import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fileFilter,
  foldCwdPath,
  joinListedPath,
  resolveBrowseTarget,
} from "../public/js/file-browser.ts";

describe("file browser path resolution", () => {
  it("starts an empty /view query at the task cwd", () => {
    assert.deepEqual(resolveBrowseTarget("", "/work/project"), {
      directory: "/work/project",
      filter: "",
    });
  });

  it("resolves relative input against the task cwd", () => {
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
      directory: "/work/project/src",
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

  it("rejects a relative query without a task cwd", () => {
    assert.throws(() => resolveBrowseTarget("src", null), /active task/i);
  });

  it("extracts the current segment for local filtering", () => {
    assert.equal(fileFilter("/work/src/serv"), "serv");
    assert.equal(fileFilter("/work/src/"), "");
    assert.equal(fileFilter("~"), "");
    assert.equal(fileFilter(".."), "..");
  });

  it("folds `.` and `..` the way the server stores a cwd", () => {
    // The picker must list, check, and send one directory, so it folds with the
    // same rule the server applies to the stored value.
    assert.equal(foldCwdPath("/w/a/b/.."), "/w/a");
    assert.equal(foldCwdPath("/w/a/link/.."), "/w/a");
    assert.equal(foldCwdPath("/w//a/./b/"), "/w/a/b");
    assert.equal(foldCwdPath("/w/a/."), "/w/a");
    assert.equal(foldCwdPath("/"), "/");
    assert.equal(foldCwdPath("/."), "/");
    assert.equal(foldCwdPath("~/a/../b"), "~/b");
    assert.equal(foldCwdPath("./~/repo"), "./~/repo");
    assert.equal(foldCwdPath("a/../b"), "b");
  });

  it("browses the directory a `..` names, not the kernel's parent", () => {
    // Typing `link/..` continues in the folded directory, so the listing and
    // the create that follows cannot disagree.
    assert.deepEqual(resolveBrowseTarget("/w/a/link/../", "/ignored"), {
      directory: "/w/a",
      filter: "",
    });
    assert.deepEqual(resolveBrowseTarget("/w/a/b/../x", "/ignored"), {
      directory: "/w/a",
      filter: "x",
    });
  });

  it("joins listed names without producing a double root slash", () => {
    assert.equal(joinListedPath("/", "etc"), "/etc");
    assert.equal(
      joinListedPath("/work/project", "a b.md"),
      "/work/project/a b.md",
    );
  });
});
