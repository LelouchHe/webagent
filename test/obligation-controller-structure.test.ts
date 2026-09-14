import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Structural guards for the obligation controller. These do not test
 * behaviour; they prove the shape that makes the recurring defect classes
 * inexpressible: one transition point, one scheduler, no exported mutable
 * record, and every fact carrying the identity of the turn it describes.
 */
const source = readFileSync(
  fileURLToPath(new URL("../src/obligation-controller.ts", import.meta.url)),
  "utf8",
);
const lines = source.split("\n");

const METHOD_DECL = /^ {2}(?:private |async |static )*([A-Za-z0-9_]+)\(/;

function methodRanges(): Array<{ name: string; start: number; end: number }> {
  const ranges: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = METHOD_DECL.exec(lines[i]);
    if (!match) continue;
    ranges.push({ name: match[1], start: i, end: lines.length });
  }
  for (let i = 0; i < ranges.length; i++) {
    ranges[i].end = i + 1 < ranges.length ? ranges[i + 1].start : lines.length;
  }
  return ranges;
}

function enclosingMethod(index: number): string | undefined {
  for (const range of methodRanges()) {
    if (index >= range.start && index < range.end) return range.name;
  }
  return undefined;
}

describe("obligation controller structure", () => {
  it("keeps the mutable record type unexported", () => {
    assert.match(source, /\ninterface ObligationRecord \{/);
    assert.doesNotMatch(source, /\nexport interface ObligationRecord \{/);
    // Callers observe a read-only projection only.
    assert.match(source, /\nexport interface ObligationView \{/);
  });

  it("arms and clears timers only inside the one scheduler", () => {
    const setTimerLines = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.includes("this.opts.setTimer("));
    const clearTimerLines = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.includes("this.opts.clearTimer("));
    // Mutation evidence: moving an arm back beside a transition adds a second
    // occurrence or relocates it outside `schedule`.
    assert.equal(setTimerLines.length, 1);
    assert.equal(clearTimerLines.length, 1);
    assert.equal(enclosingMethod(setTimerLines[0].index), "schedule");
    assert.equal(enclosingMethod(clearTimerLines[0].index), "schedule");
  });

  it("mutates record fields only from the apply call graph", () => {
    const allowed = new Set([
      "maybeRemindAtBoundary",
      "scheduleNextAttempt",
      "retrySchedule",
      "exhaust",
      "emitSilence",
      "startWatchdog",
    ]);
    // Derive the field list from the record type so a field added later is
    // covered without touching this test.
    const recordStart = source.indexOf("interface ObligationRecord {");
    const recordEnd = source.indexOf("}", recordStart);
    const recordFields = [
      ...source
        .slice(recordStart, recordEnd)
        .matchAll(/^ {2}([A-Za-z0-9_]+)\??:/gm),
    ]
      .map((match) => match[1])
      .join("|");
    assert.ok(recordFields.includes("state"));
    const writeRe = new RegExp(
      `\\b[A-Za-z0-9_]+[.](?:${recordFields}) (?:[+\\-*/]?=)(?!=)`,
    );
    for (let i = 0; i < lines.length; i++) {
      if (!writeRe.test(lines[i])) continue;
      const method = enclosingMethod(i);
      assert.ok(
        method !== undefined &&
          (method.startsWith("transition") || allowed.has(method)),
        `record write outside the apply transition graph: line ${i + 1} in ${method}`,
      );
    }
  });

  it("gives every fact the identity of the turn it describes", () => {
    const start = source.indexOf("export type ObligationFact =");
    const end = source.indexOf("export type ObligationNoticeReason");
    assert.ok(start >= 0 && end > start);
    const union = source.slice(start, end);
    // Every identity-free fact needs a documented reason; an unexplained one
    // fails the check. The list is exhaustive by construction below.
    const identityFreeReasons = new Map<string, string>([
      ["armed", "record-creating"],
      ["turn_aborted", "cleanup-scoped (bridge reset aborts whatever is busy)"],
      ["agent_activity", "unattributable (agent events carry no prompt id)"],
      ["released", "lifecycle"],
      ["settle_requested", "target-addressed-by-sole-record"],
      ["timer_due", "target-addressed-by-sole-record; kind-scoped"],
      ["disposed", "lifecycle"],
    ]);
    const members = union.split(/\n {2}\| /).slice(1);
    assert.ok(members.length >= 10, "union parse");
    const seen = new Set<string>();
    for (const member of members) {
      const typeName = /type: "([a-z_]+)"/.exec(member)?.[1];
      assert.ok(typeName, `unparsed fact member: ${member.slice(0, 40)}`);
      seen.add(typeName);
      if (
        member.includes("attemptId") ||
        member.includes("recoveryGeneration") ||
        member.includes("turnId")
      ) {
        continue;
      }
      const reason = identityFreeReasons.get(typeName);
      assert.ok(
        reason !== undefined && reason.length > 0,
        `fact ${typeName} is identity-free without a documented reason`,
      );
    }
    for (const typeName of identityFreeReasons.keys()) {
      assert.ok(
        seen.has(typeName),
        `identity-free allowlist entry ${typeName} matches no fact`,
      );
    }
  });
});
