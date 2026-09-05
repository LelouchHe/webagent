/**
 * Display-form selection for server-egress task paths.
 *
 * The server abbreviates HOME at every egress point (`cwdDisplay`,
 * `pathDisplay`); the `/view` browse grammar (file-browser.ts) owns path
 * input and completion. This module only picks the display form for
 * rendering — it never parses or expands paths.
 */

export interface DisplayPathSource {
  cwd: string;
  /** Server-abbreviated display form (e.g. `~/x`); absent outside home. */
  cwdDisplay?: string;
}

/** Server display form when present; the native path otherwise. */
export function taskDisplayPath(node: DisplayPathSource): string {
  return node.cwdDisplay ?? node.cwd;
}
