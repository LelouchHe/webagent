import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalCwd, resolveStoredCwd } from "../src/cwd-path.ts";

/**
 * A stored cwd has no `.` and no `..`, and folding follows the shell's logical
 * rules — `a/link/..` is `a`, because the user typed a path, not a symlink
 * graph. The one exception is a path that only resolves in kernel order
 * (a component after a symlink that exists only in the target); there the
 * physically resolved directory is stored instead of one that does not exist.
 *
 * Fixture (targets are relative to the link's own directory):
 *   work/{a/b, real/nested, real/side/, real/only-in-real.txt, file.txt}
 *   work/atarget -> real          (a workspace addressed through a link)
 *   work/a/link   -> ../real/nested
 *     so `a/link/..` is `real` to the kernel but `a` to `cd`, and
 *     `a/link/../side` exists only as `real/side`.
 */
describe("canonical cwd", () => {
  const home = "/home/user";
  let root: string;
  let work: string;
  /** The temp tree's physical path (`/var` is a link to `/private/var`). */
  let physicalWork: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "webagent-cwd-"));
    work = join(root, "work");
    mkdirSync(join(work, "a", "b"), { recursive: true });
    mkdirSync(join(work, "real", "nested"), { recursive: true });
    mkdirSync(join(work, "real", "side"), { recursive: true });
    writeFileSync(join(work, "file.txt"), "x");
    writeFileSync(join(work, "real", "only-in-real.txt"), "x");
    symlinkSync("real", join(work, "atarget"));
    symlinkSync(join("..", "real", "nested"), join(work, "a", "link"));
    physicalWork = realpathSync.native(work);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("folds `.` and repeated or trailing separators", () => {
    assert.equal(canonicalCwd(`${work}/a/./b`, { home }), `${work}/a/b`);
    assert.equal(canonicalCwd(`${work}//a///b/`, { home }), `${work}/a/b`);
    assert.equal(canonicalCwd(`${work}/.`, { home }), work);
    assert.equal(canonicalCwd(`${work}/./`, { home }), work);
    assert.equal(canonicalCwd("/", { home }), "/");
    assert.equal(canonicalCwd("/.", { home }), "/");
    assert.equal(canonicalCwd("", { home }), "");
  });

  it("folds `..` logically, the way `cd` reads the string", () => {
    assert.equal(canonicalCwd(`${work}/a/b/..`, { home }), `${work}/a`);
    assert.equal(canonicalCwd(`${work}/a/b/../../..`, { home }), root);
    // A symlink component is not expanded and does not stop the fold: the user
    // typed `a/link/..` and meant `a`.
    assert.equal(canonicalCwd(`${work}/a/link/..`, { home }), `${work}/a`);
    // What a shell prints for `cd a/link/../..`: two logical steps, not one
    // physical one (which would be `work/real`).
    assert.equal(canonicalCwd(`${work}/a/link/../..`, { home }), work);
  });

  it("expands HOME before folding", () => {
    assert.equal(
      canonicalCwd("~/mine/code/webagent/", { home: "/home/user" }),
      "/home/user/mine/code/webagent",
    );
    assert.equal(canonicalCwd("~/a/../b", { home }), "/home/user/b");
  });

  it("is idempotent, including a relative `~` directory", () => {
    const inputs = [
      `${work}/a/b/..`,
      `${work}/a/link/..`,
      `${work}//a/./b/`,
      "/",
      "",
      "relative/./path",
      "./~/repo",
      "~/repo",
    ];
    for (const input of inputs) {
      const once = canonicalCwd(input, { home });
      assert.notEqual(once, null, input);
      assert.equal(canonicalCwd(once!, { home }), once, input);
    }
    // A directory literally named `~` keeps the `./` that stops a later pass
    // from reading it as HOME.
    assert.equal(canonicalCwd("./~/repo/", { home }), "./~/repo");
  });

  it("drops a relative `.` and keeps a leading `..`", () => {
    assert.equal(canonicalCwd("./a/./b", { home }), "a/b");
    assert.equal(canonicalCwd("../../a", { home }), "../../a");
  });

  describe("resolveStoredCwd", () => {
    it("stores the logical directory when it exists", () => {
      // `work/a/link` reaches `work/real`; the kernel would give `work/real`
      // for `link/..`, but the user typed a path and meant `work/a`.
      assert.equal(
        resolveStoredCwd(`${work}/a/link/..`, { home }),
        `${work}/a`,
      );
      assert.equal(resolveStoredCwd(`${work}/a/b/..`, { home }), `${work}/a`);
    });

    it("falls back to the physical directory when only that one exists", () => {
      // `only-in-real.txt` exists beside the symlink target, not in `work/a`.
      assert.equal(
        resolveStoredCwd(`${work}/a/link/../side`, { home }),
        `${physicalWork}/real/side`,
      );
      // A symlink component is still preserved when the path resolves through
      // it without a `..` to fold.
      assert.equal(
        resolveStoredCwd(`${work}/atarget/nested`, { home }),
        `${work}/atarget/nested`,
      );
    });

    it("reports an unverifiable `..` instead of folding it", () => {
      // `missing` does not exist, so `missing/..` is not `work`: the input is
      // returned unchanged for the caller's validation to reject.
      assert.equal(
        resolveStoredCwd(`${work}/missing/..`, { home }),
        `${work}/missing/..`,
      );
      assert.equal(canonicalCwd(`${work}/missing/..`, { home }), null);
    });

    it("is idempotent", () => {
      const inputs = [
        `${work}/a/link/..`,
        `${work}/a/link/../side`,
        `${work}/a/b/./..`,
        "/",
        "",
      ];
      for (const input of inputs) {
        const once = resolveStoredCwd(input, { home });
        assert.equal(resolveStoredCwd(once, { home }), once, input);
      }
    });
  });
});
