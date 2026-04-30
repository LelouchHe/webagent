import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  resolveSessionsAnchor,
  isInsideSessionAttachments,
} from "../src/sessions-anchor.ts";

const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("resolveSessionsAnchor", () => {
  it("creates <dataDir>/sessions/ when missing and returns realpath", () => {
    const data = mkdtempSync(join(tmpdir(), "anchor-"));
    tmpDirs.push(data);

    const anchor = resolveSessionsAnchor(data);
    assert.equal(anchor, realpathSync(join(data, "sessions")));
    assert.ok(!anchor.endsWith(sep), "anchor should not end with separator");
  });

  it("resolves through symlinks (macOS /var → /private/var trap)", () => {
    const data = mkdtempSync(join(tmpdir(), "anchor-sym-"));
    tmpDirs.push(data);
    const realTarget = mkdtempSync(join(tmpdir(), "anchor-real-"));
    tmpDirs.push(realTarget);

    // Make data/sessions a symlink to a realTarget directory.
    symlinkSync(realTarget, join(data, "sessions"), "dir");

    const anchor = resolveSessionsAnchor(data);
    assert.equal(anchor, realpathSync(realTarget));
  });

  it("is idempotent across calls", () => {
    const data = mkdtempSync(join(tmpdir(), "anchor-idem-"));
    tmpDirs.push(data);

    const a = resolveSessionsAnchor(data);
    const b = resolveSessionsAnchor(data);
    assert.equal(a, b);
  });
});

describe("isInsideSessionAttachments", () => {
  const anchor = "/data/sessions";

  it("accepts a path strictly under <anchor>/<sid>/attachments/", () => {
    assert.equal(
      isInsideSessionAttachments(
        anchor,
        "s1",
        "/data/sessions/s1/attachments/abc.png",
      ),
      true,
    );
  });

  it("rejects paths under a different session", () => {
    assert.equal(
      isInsideSessionAttachments(
        anchor,
        "s1",
        "/data/sessions/s2/attachments/abc.png",
      ),
      false,
    );
  });

  it("rejects paths outside the attachments subdir", () => {
    assert.equal(
      isInsideSessionAttachments(
        anchor,
        "s1",
        "/data/sessions/s1/other/abc.png",
      ),
      false,
    );
  });

  it("rejects sibling sessions whose id is a prefix (s1 vs s10)", () => {
    // Without the sep boundary, s10/attachments/* would falsely match s1.
    assert.equal(
      isInsideSessionAttachments(
        anchor,
        "s1",
        "/data/sessions/s10/attachments/abc.png",
      ),
      false,
    );
  });

  it("rejects the attachments dir itself (must be strict descendant)", () => {
    assert.equal(
      isInsideSessionAttachments(anchor, "s1", "/data/sessions/s1/attachments"),
      false,
    );
  });

  it("rejects an entirely unrelated path", () => {
    assert.equal(
      isInsideSessionAttachments(anchor, "s1", "/etc/passwd"),
      false,
    );
  });
});

// Used to silence unused-import warnings from mkdirSync if the test fixture
// helpers grow; currently mkdirSync is imported defensively.
void mkdirSync;
