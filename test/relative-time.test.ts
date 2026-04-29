// Tests for the public viewer's relative-time formatter.
//
// The helper renders an ISO timestamp as a short, reader-friendly string
// (`5m ago`, `Apr 28`, etc.) for display in the share-viewer footer. Pure
// function: takes the timestamp + a "now" reference (so tests don't depend
// on Date.now()).
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  formatRelativeTime,
  formatExactUtc,
} from "../public/js/relative-time.ts";

const NOW = new Date("2026-04-28T12:00:00Z");

describe("formatRelativeTime", () => {
  it("returns 'just now' for < 60s in the past", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T11:59:30Z").toISOString(), NOW),
      "just now",
    );
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T12:00:00Z").toISOString(), NOW),
      "just now",
    );
  });

  it("returns 'just now' for clock-skew slightly in the future", () => {
    // Clients can have small clock drift; a 30s positive delta should
    // not render as "30s in the future" — degrade to "just now".
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T12:00:30Z").toISOString(), NOW),
      "just now",
    );
  });

  it("returns 'Nm ago' for < 60 minutes", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T11:55:00Z").toISOString(), NOW),
      "5m ago",
    );
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T11:01:00Z").toISOString(), NOW),
      "59m ago",
    );
  });

  it("returns 'Nh ago' for < 24 hours", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T09:00:00Z").toISOString(), NOW),
      "3h ago",
    );
    assert.equal(
      formatRelativeTime(new Date("2026-04-27T13:00:00Z").toISOString(), NOW),
      "23h ago",
    );
  });

  it("returns 'Nd ago' for < 7 days", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-26T12:00:00Z").toISOString(), NOW),
      "2d ago",
    );
    assert.equal(
      formatRelativeTime(new Date("2026-04-22T12:00:00Z").toISOString(), NOW),
      "6d ago",
    );
  });

  it("returns 'Mon DD' for same-year dates ≥ 7 days old", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-01-15T08:00:00Z").toISOString(), NOW),
      "Jan 15",
    );
    assert.equal(
      formatRelativeTime(new Date("2026-04-21T12:00:00Z").toISOString(), NOW),
      "Apr 21",
    );
  });

  it("returns 'Mon DD, YYYY' for different-year dates", () => {
    assert.equal(
      formatRelativeTime(new Date("2024-06-12T10:00:00Z").toISOString(), NOW),
      "Jun 12, 2024",
    );
    assert.equal(
      formatRelativeTime(new Date("2025-12-31T23:59:00Z").toISOString(), NOW),
      "Dec 31, 2025",
    );
  });

  it("returns empty string for invalid input", () => {
    assert.equal(formatRelativeTime("", NOW), "");
    assert.equal(formatRelativeTime("not-a-date", NOW), "");
  });

  it("threshold boundary: exactly 60s ago → '1m ago', not 'just now'", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T11:59:00Z").toISOString(), NOW),
      "1m ago",
    );
  });

  it("threshold boundary: exactly 1h ago → '1h ago', not '60m ago'", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-28T11:00:00Z").toISOString(), NOW),
      "1h ago",
    );
  });

  it("threshold boundary: exactly 24h ago → '1d ago', not '24h ago'", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-27T12:00:00Z").toISOString(), NOW),
      "1d ago",
    );
  });

  it("threshold boundary: exactly 7d ago → date form", () => {
    assert.equal(
      formatRelativeTime(new Date("2026-04-21T12:00:00Z").toISOString(), NOW),
      "Apr 21",
    );
  });
});

describe("formatExactUtc", () => {
  it("formats as 'YYYY-MM-DD HH:MM UTC'", () => {
    assert.equal(
      formatExactUtc(new Date("2026-04-28T05:19:00Z").toISOString()),
      "2026-04-28 05:19 UTC",
    );
  });

  it("zero-pads single-digit components", () => {
    assert.equal(
      formatExactUtc(new Date("2026-01-05T03:09:00Z").toISOString()),
      "2026-01-05 03:09 UTC",
    );
  });

  it("returns empty string for invalid input", () => {
    assert.equal(formatExactUtc(""), "");
    assert.equal(formatExactUtc("not-a-date"), "");
  });
});
