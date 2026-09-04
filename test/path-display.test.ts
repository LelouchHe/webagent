import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  displayBasename,
  displayDirname,
  isDisplayAbsolutePath,
  joinDisplay,
  resolveDisplayTarget,
  taskDisplayPath,
} from "../public/js/path-display.ts";

describe("shared display-path utils", () => {
  it("classifies home-relative and absolute display paths", () => {
    assert.equal(isDisplayAbsolutePath("~"), true);
    assert.equal(isDisplayAbsolutePath("~/a/b"), true);
    assert.equal(isDisplayAbsolutePath("/abs"), true);
    assert.equal(isDisplayAbsolutePath("~name"), false);
    assert.equal(isDisplayAbsolutePath("relative"), false);
  });

  it("splits display paths at the last separator", () => {
    assert.deepEqual(displayDirname("/a/b"), "/a");
    assert.deepEqual(displayBasename("/a/b"), "b");
    // `~` is itself a directory form: its children join as `~/name`.
    assert.deepEqual(displayDirname("~/a"), "~");
    assert.deepEqual(displayBasename("~/a"), "a");
    assert.deepEqual(displayDirname("~"), "~");
    assert.deepEqual(displayBasename("~"), "");
    assert.deepEqual(displayDirname("/"), "/");
    assert.deepEqual(displayBasename("/"), "");
  });

  it("joins one display directory and one segment", () => {
    assert.equal(joinDisplay("~", "a"), "~/a");
    assert.equal(joinDisplay("~", ""), "~");
    assert.equal(joinDisplay("/a", "b"), "/a/b");
    assert.equal(joinDisplay("/", "b"), "/b");
  });

  it("selects the server display form when present", () => {
    assert.equal(
      taskDisplayPath({ cwd: "/Users/u/x", cwdDisplay: "~/x" }),
      "~/x",
    );
    assert.equal(taskDisplayPath({ cwd: "/Users/u/x" }), "/Users/u/x");
  });

  it("resolves + targets: ~-forms pass through, relative forms resolve", () => {
    // `~` targets stay display-absolute: the backend owns expansion.
    assert.equal(resolveDisplayTarget("/base", "~/p/name"), "~/p/name");
    assert.equal(resolveDisplayTarget("/base", "~"), "~");
    assert.equal(resolveDisplayTarget("/base", "name"), "/base/name");
    assert.equal(resolveDisplayTarget("/base", "./name"), "/base/name");
    assert.equal(resolveDisplayTarget("/base", "../other/name"), "/other/name");
    assert.equal(resolveDisplayTarget("/base", ""), "/base");
  });
});
