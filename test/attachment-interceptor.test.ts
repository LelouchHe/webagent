import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import {
  shouldAutoApproveAttachmentRead,
  createCounters,
  type InterceptorCounters,
  type InterceptorDeps,
} from "../src/attachment-interceptor.ts";

describe("attachment permission interceptor", () => {
  let tmp: string;
  let attRealpath: string;
  let outsideRealpath: string;

  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "att-int-")));
    const sDir = join(tmp, "s1", "attachments");
    mkdirSync(sDir, { recursive: true });
    const f = join(sDir, "a1.png");
    writeFileSync(f, Buffer.from([1, 2, 3]));
    attRealpath = realpathSync(f);

    const outside = join(tmp, "etc-passwd");
    writeFileSync(outside, "secret");
    outsideRealpath = realpathSync(outside);
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  let counters: InterceptorCounters;
  let warnings: string[];
  let infos: string[];
  const baseDeps = (): InterceptorDeps => ({
    listAttachmentRealpaths: () => [attRealpath],
    counters,
    logger: {
      debug: () => {},
      warn: (m) => {
        warnings.push(m);
      },
      info: (m) => {
        infos.push(m);
      },
    },
  });

  beforeEach(() => {
    counters = createCounters();
    warnings = [];
    infos = [];
  });

  it("happy path: kind=read + no name + locations match + no rawInput", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }],
      },
      baseDeps(),
    );
    assert.equal(ok, true);
    assert.equal(counters.autoAllowed, 1);
    assert.equal(counters.fellThrough, 0);
  });

  it("kind=execute → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "execute",
        locations: [{ path: attRealpath }],
      },
      baseDeps(),
    );
    assert.equal(ok, false);
    assert.equal(counters.fellThrough, 1);
  });

  it("kind undefined → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      { sessionId: "s1", locations: [{ path: attRealpath }] },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("name=view (allowlisted) → true", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        toolName: "view",
        locations: [{ path: attRealpath }],
      },
      baseDeps(),
    );
    assert.equal(ok, true);
  });

  it("name=bash (not allowlisted) → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        toolName: "bash",
        locations: [{ path: attRealpath }],
      },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("locations === [] → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      { sessionId: "s1", toolKind: "read", locations: [] },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("locations missing → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      { sessionId: "s1", toolKind: "read" },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("location outside attachment set → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: outsideRealpath }],
      },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("rawInput.path matching → true", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }],
        rawInput: { path: attRealpath },
      },
      baseDeps(),
    );
    assert.equal(ok, true);
  });

  it("rawInput.filePath matching → true", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }],
        rawInput: { filePath: attRealpath },
      },
      baseDeps(),
    );
    assert.equal(ok, true);
  });

  it("rawInput.path outside attachment set → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }],
        rawInput: { path: outsideRealpath },
      },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("rawInput.filePath mismatch → false even if path matches", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }],
        rawInput: { path: attRealpath, filePath: outsideRealpath },
      },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("rawInput unknown keys only → schemaDrift bumped, allow", async () => {
    let drifted = 0;
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }],
        rawInput: { mystery_path: attRealpath },
      },
      {
        ...baseDeps(),
        onSchemaDrift: () => {
          drifted++;
        },
      },
    );
    assert.equal(ok, true);
    assert.equal(counters.schemaDrift, 1);
    assert.equal(drifted, 1);
  });

  it("cross-session attachment → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s2",
        toolKind: "read",
        locations: [{ path: attRealpath }],
      },
      {
        ...baseDeps(),
        listAttachmentRealpaths: (sid) => (sid === "s1" ? [attRealpath] : []),
      },
    );
    assert.equal(ok, false);
  });

  it("multi-location: one match + one outside → false", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }, { path: outsideRealpath }],
      },
      baseDeps(),
    );
    assert.equal(ok, false);
  });

  it("realpath ENOENT → false + counter", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: join(tmp, "does-not-exist") }],
      },
      baseDeps(),
    );
    assert.equal(ok, false);
    assert.equal(counters.realpathErrors, 1);
  });

  it("listAttachmentRealpaths throws → false (db_error)", async () => {
    const ok = await shouldAutoApproveAttachmentRead(
      {
        sessionId: "s1",
        toolKind: "read",
        locations: [{ path: attRealpath }],
      },
      {
        ...baseDeps(),
        listAttachmentRealpaths: () => {
          throw new Error("db boom");
        },
      },
    );
    assert.equal(ok, false);
    assert.ok(warnings.some((w) => w.includes("db error")));
  });
});
