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
      "fireDue",
    ]);
    const recordFields = [
      "sourceTaskId",
      "targetTaskId",
      "openingMessageId",
      "openingDeliveryId",
      "openedAt",
      "attemptId",
      "recoveryGeneration",
      "state",
      "deliveredAttempts",
      "consecutiveSubmissionFailures",
      "lastDeliveredAttemptAt",
      "waitingSince",
      "retrying",
      "dispatchAdvised",
      "ageAdvised",
      "silencedAttemptId",
      "dispatchAdvisoryFrom",
      "ageAdvisoryFrom",
      "noAccountNotified",
    ].join("|");
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
    // Facts that create a record, address the target's sole record by target
    // id, or are lifecycle events do not describe a specific turn.
    const identityFree = new Set([
      "armed",
      "turn_ended",
      "turn_aborted",
      "agent_activity",
      "released",
      "settle_requested",
      "timer_due",
      "disposed",
    ]);
    const members = union.split(/\n {2}\| /).slice(1);
    assert.ok(members.length >= 10, "union parse");
    for (const member of members) {
      const typeName = /type: "([a-z_]+)"/.exec(member)?.[1];
      assert.ok(typeName, `unparsed fact member: ${member.slice(0, 40)}`);
      if (identityFree.has(typeName)) continue;
      assert.ok(
        member.includes("attemptId") || member.includes("recoveryGeneration"),
        `fact ${typeName} lacks a turn identity`,
      );
    }
  });
});
