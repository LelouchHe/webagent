// Public viewer's relative-time formatter.
//
// Renders a stored ISO timestamp as a short, reader-friendly string for
// the share-viewer footer. Tiered output:
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
// Intentionally English-only: viewer pages are public links shared with
// readers of unknown locale; English relative-time strings are the
// internet lingua franca (GitHub / Slack / Discord all use them). The
// owner-facing main app uses formatLocalTime() for its own formatting,
// and may localize independently.

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
 * Format an ISO timestamp as a short relative-time string. Returns "" on
 * invalid input. `now` is injected so unit tests can fix the reference
 * point; pass `new Date()` in production.
 */
export function formatRelativeTime(iso: string, now: Date): string {
  if (!iso) return "";
  const d = new Date(iso);
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
 * Format an ISO timestamp as an exact UTC string for tooltip display:
 * "2026-04-28 05:19 UTC". Companion to formatRelativeTime — readers who
 * want the precise moment hover the relative label.
 */
export function formatExactUtc(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
  );
}
