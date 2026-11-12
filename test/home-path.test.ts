import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { abbreviateHomePath, expandHomePath } from "../src/home-path.ts";

describe("home paths", () => {
  const home = "/Users/lelouch";

  it("expands the current user's home shorthand", () => {
    assert.equal(expandHomePath("~", home), home);
    assert.equal(
      expandHomePath("~/mine/code/webagent", home),
      "/Users/lelouch/mine/code/webagent",
    );
  });

  it("does not expand named users or unrelated paths", () => {
    assert.equal(expandHomePath("~other/project", home), "~other/project");
    assert.equal(expandHomePath("/tmp/project", home), "/tmp/project");
  });

  it("returns one spelling per directory", () => {
    // One directory, several typings: a task cwd and the recent-path key built
    // from it must not depend on how the user typed the path.
    assert.equal(expandHomePath("/tmp/project/", home), "/tmp/project");
    assert.equal(expandHomePath("/tmp/project/./", home), "/tmp/project");
    assert.equal(expandHomePath("/tmp//project", home), "/tmp/project");
    assert.equal(expandHomePath("/tmp/other/../project", home), "/tmp/project");
    assert.equal(
      expandHomePath("~/mine/code/webagent/", home),
      "/Users/lelouch/mine/code/webagent",
    );
    assert.equal(
      expandHomePath("~/mine/../mine/code", home),
      "/Users/lelouch/mine/code",
    );
    // Root and an empty field keep their identity.
    assert.equal(expandHomePath("/", home), "/");
    assert.equal(expandHomePath("", home), "");
  });

  it("abbreviates only paths inside the current user's home", () => {
    assert.equal(abbreviateHomePath(home, home), "~");
    assert.equal(
      abbreviateHomePath("/Users/lelouch/mine/code", home),
      "~/mine/code",
    );
    assert.equal(
      abbreviateHomePath("/Users/lelouch-old/project", home),
      "/Users/lelouch-old/project",
    );
    assert.equal(abbreviateHomePath("/tmp/project", home), "/tmp/project");
  });

  it("round-trips Windows HOME paths through portable display syntax", () => {
    const windowsHome = "C:\\Users\\lelouch";
    assert.equal(
      abbreviateHomePath("C:\\Users\\lelouch\\mine\\code", windowsHome, win32),
      "~/mine/code",
    );
    assert.equal(
      expandHomePath("~\\mine\\code", windowsHome, win32),
      "C:\\Users\\lelouch\\mine\\code",
    );
    assert.equal(
      expandHomePath("~/mine/code", windowsHome, win32),
      "C:\\Users\\lelouch\\mine\\code",
    );
    assert.equal(
      expandHomePath("C:\\Users\\lelouch\\mine\\code\\", windowsHome, win32),
      "C:\\Users\\lelouch\\mine\\code",
    );
    assert.equal(
      abbreviateHomePath("D:\\project\\file.ts", windowsHome, win32),
      "D:/project/file.ts",
    );
  });
});
