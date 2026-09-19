/**
 * Egress rendering for stored timestamps.
 *
 * Persistence stores unix milliseconds in an INTEGER column; every egress
 * surface renders that as ISO-8601 UTC with an explicit `Z`, so no reader has
 * to remember which representation it is looking at.
 */
export function isoFromMillis(ms: number): string {
  return new Date(ms).toISOString();
}

/** `isoFromMillis` for an optional stored value; absent stays absent. */
export function isoFromMillisOrNull(
  ms: number | null | undefined,
): string | null {
  return ms === null || ms === undefined ? null : isoFromMillis(ms);
}
