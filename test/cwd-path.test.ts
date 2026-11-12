import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalCwd } from "../src/cwd-path.ts";

/**
 * The stored cwd rule: `.` and `..` folded the way a shell's `cd` folds them,
 * repeated and trailing separators removed, roots and symlink spellings intact.
 *
 * It is pure string work — no `stat`, no `realpath` — so these cases need no
 * filesystem, and `a/link/..` is `a` without knowing what `link` points at.
 */
describe("canonical cwd", () => {
  const home = "/home/user";
  const fold = (input: string) => canonicalCwd(input, { home });

  it("folds `.` and repeated or trailing separators", () => {
    assert.equal(fold("/tmp/a/./b"), "/tmp/a/b");
    assert.equal(fold("/tmp//a///b/"), "/tmp/a/b");
    assert.equal(fold("/tmp/a/."), "/tmp/a");
    assert.equal(fold("/tmp/a/./"), "/tmp/a");
    assert.equal(fold("/"), "/");
    assert.equal(fold("/."), "/");
    assert.equal(fold(""), "");
  });

  it("folds `..` logically, the way `cd` reads the string", () => {
    assert.equal(fold("/tmp/a/b/.."), "/tmp/a");
    assert.equal(fold("/tmp/a/b/../../.."), "/");
    // A symlink component is not expanded and does not stop the fold: the user
    // typed `a/link/..` and meant `a`.
    assert.equal(fold("/tmp/a/link/.."), "/tmp/a");
    assert.equal(fold("/tmp/a/link/../.."), "/tmp");
    // Nothing to fold against: the segment stays.
    assert.equal(fold("../../a"), "../../a");
  });

  it("expands HOME before folding", () => {
    assert.equal(
      fold("~/mine/code/webagent/"),
      "/home/user/mine/code/webagent",
    );
    assert.equal(fold("~/a/../b"), "/home/user/b");
    assert.equal(fold("~"), "/home/user");
  });

  it("is idempotent, including a relative directory named `~`", () => {
    const inputs = [
      "/tmp/a/b/..",
      "/tmp/a/link/..",
      "/tmp//a/./b/",
      "/",
      "",
      "relative/./path",
      "./~/repo",
      "~/repo",
      "~",
    ];
    for (const input of inputs) {
      const once = fold(input);
      assert.equal(fold(once), once, input);
    }
    // Dropping the leading `.` may not turn a plain directory name into HOME
    // shorthand, so the `./` stays.
    assert.equal(fold("./~/repo/"), "./~/repo");
  });

  it("drops a relative `.` and keeps a leading `..`", () => {
    assert.equal(fold("./a/./b"), "a/b");
    assert.equal(fold("."), ".");
  });
});
