import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import {
  abbreviateHomePath,
  canonicalDirectoryPath,
  expandHomePath,
} from "../src/home-path.ts";

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

  it("leaves expansion-only callers the path they typed", () => {
    // The file API resolves paths with `realpath`, where a lexical rewrite of
    // `link/..` would address a different file than the filesystem does.
    assert.equal(expandHomePath("/tmp/project/", home), "/tmp/project/");
    assert.equal(
      expandHomePath("/tmp/a/link/../note.txt", home),
      "/tmp/a/link/../note.txt",
    );
  });

  it("collapses trailing separators and trailing `.` segments", () => {
    // One directory, several typings: a task cwd and the recent-path key built
    // from it must not depend on how the user typed the trailing end.
    assert.equal(canonicalDirectoryPath("/tmp/project/", home), "/tmp/project");
    assert.equal(
      canonicalDirectoryPath("/tmp/project/./", home),
      "/tmp/project",
    );
    assert.equal(canonicalDirectoryPath("/x/.", home), "/x");
    assert.equal(
      canonicalDirectoryPath("~/mine/code/webagent/", home),
      "/Users/lelouch/mine/code/webagent",
    );
    // Relative input keeps its meaning and loses the same trailing parts.
    assert.equal(canonicalDirectoryPath("src/", home), "src");
    assert.equal(canonicalDirectoryPath("src/./", home), "src");
    // Root and an empty field keep their identity; a `.` under a root names
    // that root and never collapses to an empty path.
    assert.equal(canonicalDirectoryPath("/", home), "/");
    assert.equal(canonicalDirectoryPath("/.", home), "/");
    assert.equal(canonicalDirectoryPath("/./", home), "/");
    assert.equal(canonicalDirectoryPath("", home), "");
  });

  it("never rewrites a path across a symlink", () => {
    // Lexical folding is not the filesystem: with `a/link -> b/nested`,
    // `a/link/..` is `b`. Rewriting it would move a task to another directory,
    // so interior segments are preserved verbatim.
    assert.equal(
      canonicalDirectoryPath("/base/a/link/../note.txt", home),
      "/base/a/link/../note.txt",
    );
    assert.equal(
      canonicalDirectoryPath("/tmp//project", home),
      "/tmp//project",
    );
    assert.equal(canonicalDirectoryPath("./src", home), "./src");
  });

  it("is idempotent, including a directory literally named ~", () => {
    // Both the task-cwd ingress and the storage boundary canonicalize, and a
    // stored value is canonicalized again after a reopen.
    const inputs = [
      "/tmp/project/",
      "/tmp/project/./",
      "/x/././",
      "~/mine/code/webagent/",
      "/base/a/link/..",
      "./~/repo",
      "./~/repo/",
      "src/./",
      "/",
      "",
    ];
    for (const input of inputs) {
      const once = canonicalDirectoryPath(input, home);
      assert.equal(canonicalDirectoryPath(once, home), once, input);
    }
    // A literal `~` directory in a relative path is not HOME.
    assert.equal(canonicalDirectoryPath("./~/repo/", home), "./~/repo");
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
      canonicalDirectoryPath(
        "C:\\Users\\lelouch\\mine\\code\\",
        windowsHome,
        win32,
      ),
      "C:\\Users\\lelouch\\mine\\code",
    );
    assert.equal(
      canonicalDirectoryPath("~\\mine\\code\\", windowsHome, win32),
      "C:\\Users\\lelouch\\mine\\code",
    );
    // A root is a root: trimming its separator would change the object a path
    // names — `\\.\C:` is the volume device, `\\.\C:\` the filesystem.
    assert.equal(canonicalDirectoryPath("C:\\", windowsHome, win32), "C:\\");
    assert.equal(
      canonicalDirectoryPath("\\\\.\\C:\\", windowsHome, win32),
      "\\\\.\\C:\\",
    );
    assert.equal(
      canonicalDirectoryPath("\\\\srv\\share\\", windowsHome, win32),
      "\\\\srv\\share\\",
    );
    // A trailing `.` under a root yields the root, not `C:` (drive-relative).
    assert.equal(canonicalDirectoryPath("C:\\.", windowsHome, win32), "C:\\");
    assert.equal(
      canonicalDirectoryPath("\\\\.\\C:\\.", windowsHome, win32),
      "\\\\.\\C:\\",
    );
    assert.equal(
      abbreviateHomePath("D:\\project\\file.ts", windowsHome, win32),
      "D:/project/file.ts",
    );
  });
});
