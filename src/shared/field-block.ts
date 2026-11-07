/**
 * Render a readable `key: value` block — the shape both a notice body and a
 * task-created system message use.
 *
 * Values are emitted verbatim: no escaping, no trimming, no reordering. A
 * `fallback` is used only when the value is falsy, so an empty string renders
 * the fallback (that is what "inherited model" relies on); a field without one
 * keeps its empty value instead of disappearing.
 */
export interface FieldBlockEntry {
  label: string;
  value: string;
  /** Rendered instead of `value` when the value is falsy. */
  fallback?: string;
}

export function formatFieldBlock(entries: readonly FieldBlockEntry[]): string {
  return entries
    .map(({ label, value, fallback }) => {
      const rendered = fallback !== undefined && !value ? fallback : value;
      return `${label}: ${rendered}`;
    })
    .join("\n");
}
