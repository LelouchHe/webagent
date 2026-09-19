// Relative-time formatter — shared between the share viewer and any
// other frontend surface that needs short, reader-friendly elapsed
// strings. Tiered output:
//
//   < 1 min  → "just now"
//   < 1 hour → "5m ago"
//   < 1 day  → "3h ago"
//   < 7 days → "2d ago"
//   same yr  → "Apr 28"
//   else     → "Apr 28, 2024"
//
// Pure function — takes an explicit "now" so tests don't depend on the
// real clock. Production callers pass `new Date()`.
//
// Intentionally English-only and clock-injected: the share viewer is a
// public link shared with readers of unknown locale, so English
// relative-time strings (the GitHub / Slack / Discord lingua franca)
// are the right default for anything externally visible. Owner-facing
// surfaces in the main app are free to localize independently using
// their own helpers (see formatLocalTime in date-format.ts).

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Parse a stored or egressed timestamp.
 *
 * Numbers are unix milliseconds. Strings carrying `Z` or an explicit offset
 * are parsed as written. A bare `YYYY-MM-DD HH:MM:SS[.SSS]` string has no
 * timezone marker and is UTC, so `Z` is patched before parsing.
 *
 * That last branch is **deploy-window tolerance, not the storage contract**.
 * Storage is INTEGER unix milliseconds and egress renders ISO-8601 with `Z`;
 * the fallback only keeps an already-cached old frontend or a backend that has
 * not restarted yet reading the right instant.
 */
export function parseTimestamp(value: string | number): Date {
  if (typeof value === "number") return new Date(value);
  const marked = value.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(value);
  return new Date(marked ? value : `${value}Z`);
}

/**
 * Format an ISO-8601 string or unix milliseconds as a short relative-time
 * string. Returns "" on invalid input. `now` is injected so unit tests can fix
 * the reference point; pass `new Date()` in production.
 */
export function formatRelativeTime(value: string | number, now: Date): string {
  if (value === "") return "";
  const d = parseTimestamp(value);
  const t = d.getTime();
  if (isNaN(t)) return "";

  const deltaSec = Math.floor((now.getTime() - t) / 1000);

  // Future-dated (clock skew) or under a minute → "just now". We
  // deliberately don't render "in 5m" — readers don't expect future
  // timestamps on a snapshot page; the failure mode of a small skew
  // should be benign.
  if (deltaSec < 60) return "just now";

  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;

  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;

  // ≥ 7 days: switch to absolute date. Year suffix only when different
  // from "now" (matches GitHub / Slack convention).
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  const month = MONTHS[d.getUTCMonth()];
  const date = d.getUTCDate();
  return sameYear
    ? `${month} ${date}`
    : `${month} ${date}, ${d.getUTCFullYear()}`;
}

/**
 * Format an ISO-8601 string or unix milliseconds as an exact UTC string for
 * tooltip display: "2026-04-28 05:19 UTC". Companion to formatRelativeTime —
 * readers who want the precise moment hover the relative label.
 */
export function formatExactUtc(value: string | number): string {
  if (value === "") return "";
  const d = parseTimestamp(value);
  if (isNaN(d.getTime())) return "";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
  );
}
