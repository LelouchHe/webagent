import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalCwd } from "../src/cwd-path.ts";

/**
 * A stored cwd has no `.` and no `..`, but removing a `..` is only transparent
 * when the component before it is a real directory. These cases pin both sides:
 * fold what the filesystem allows, keep what it does not.
 *
 * Fixture:
 *   root/work/{a/b, real/nested, redirect -> real/nested, linkdir -> real}
 *   root/file.txt
 */
describe("canonical cwd", () => {
  const home = "/home/user";
  let root: string;
  let work: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "webagent-cwd-"));
    work = join(root, "work");
    mkdirSync(join(work, "a", "b"), { recursive: true });
    mkdirSync(join(work, "real", "nested"), { recursive: true });
    writeFileSync(join(root, "file.txt"), "x");
    // Targets are relative to the link's own directory.
    symlinkSync(join("real", "nested"), join(work, "redirect"));
    symlinkSync("real", join(work, "linkdir"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes `.` and repeated or trailing separators", () => {
    assert.equal(canonicalCwd(`${work}/a/./b`, { home }), `${work}/a/b`);
    assert.equal(canonicalCwd(`${work}//a///b/`, { home }), `${work}/a/b`);
    assert.equal(canonicalCwd(`${work}/.`, { home }), work);
    assert.equal(canonicalCwd(`${work}/./`, { home }), work);
    assert.equal(canonicalCwd("/", { home }), "/");
    assert.equal(canonicalCwd("/.", { home }), "/");
    assert.equal(canonicalCwd("", { home }), "");
  });

  it("folds `..` across a real directory", () => {
    assert.equal(canonicalCwd(`${work}/a/b/..`, { home }), `${work}/a`);
    assert.equal(canonicalCwd(`${work}/a/b/../../..`, { home }), root);
    assert.equal(canonicalCwd(`${root}/nope/..`, { home }), `${root}/nope/..`);
  });

  it("keeps a `..` that follows a symlink", () => {
    // `work/redirect/..` is `work/real`, not `work`: removing the segment
    // would mean expanding the symlink the caller typed.
    assert.equal(
      canonicalCwd(`${work}/redirect/..`, { home }),
      `${work}/redirect/..`,
    );
    // A real directory *below* the symlink can still be folded away: the fold
    // is verified against the directory the symlink actually reaches.
    assert.equal(
      canonicalCwd(`${work}/linkdir/nested/..`, { home }),
      `${work}/linkdir`,
    );
  });

  it("never collapses two `..` into one", () => {
    // Each `..` resolves from wherever the previous traversal landed, so a
    // pair is not algebraically reducible once a symlink is involved.
    assert.equal(
      canonicalCwd(`${work}/redirect/../../x`, { home }),
      `${work}/redirect/../../x`,
    );
    // The real `nested` folds into its symlinked parent, then the `..` after
    // the symlink stands: nothing can be collapsed further.
    assert.equal(
      canonicalCwd(`${work}/linkdir/nested/../../x`, { home }),
      `${work}/linkdir/../x`,
    );
  });

  it("expands HOME before folding and keeps symlink spellings under it", () => {
    assert.equal(
      canonicalCwd("~/mine/code/webagent/", { home: "/home/user" }),
      "/home/user/mine/code/webagent",
    );
    // Tilde input goes through path.join, which folds interior segments; the
    // fold here must not invent a second rule for it.
    assert.equal(canonicalCwd("~/a/../b", { home }), "/home/user/b");
  });

  it("is idempotent", () => {
    const inputs = [
      `${work}/a/b/..`,
      `${work}/linkdir/nested/..`,
      `${work}/redirect/../../x`,
      `${work}//a/./b/`,
      "/",
      "",
      "relative/./path",
    ];
    for (const input of inputs) {
      const once = canonicalCwd(input, { home });
      assert.equal(canonicalCwd(once, { home }), once, input);
    }
  });

  it("drops a relative `.` and keeps a leading `..`", () => {
    assert.equal(canonicalCwd("./a/./b", { home }), "a/b");
    assert.equal(canonicalCwd("../../a", { home }), "../../a");
  });

  it("never turns a relative `~` directory into HOME shorthand", () => {
    // `./~/repo` is a directory named `~`; without the `./` the next pass (the
    // store canonicalizes again) would expand it to HOME.
    assert.equal(canonicalCwd("./~/repo", { home }), "./~/repo");
    assert.equal(canonicalCwd("./~/repo/", { home }), "./~/repo");
    // A `..` that cannot be verified is left alone, so no `~` is produced.
    assert.equal(canonicalCwd("a/../~/x", { home }), "a/../~/x");
    // Folding a verified absolute prefix into a `~` directory keeps it a
    // plain name for the next pass.
    assert.equal(canonicalCwd(`${work}/a/../~/x`, { home }), `${work}/~/x`);
    // A real tilde prefix is still expanded, once.
    assert.equal(canonicalCwd("~/repo", { home }), `${home}/repo`);
    assert.equal(canonicalCwd(`${home}/repo`, { home }), `${home}/repo`);
  });
});
