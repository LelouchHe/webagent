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
      abbreviateHomePath("D:\\project\\file.ts", windowsHome, win32),
      "D:/project/file.ts",
    );
  });
});
