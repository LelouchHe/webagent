import { basename } from "node:path";

import type { AgentEvent } from "./types.ts";

/**
 * Egress-time map keyed by the strings agents put into events
 * (full realpaths and basenames) → the user-visible label
 * `<name> [#<id4>]`.
 *
 * See CLAUDE.md "Attachment label egress rewrite" for the full
 * design. Storage stays raw (uuid paths in events.data); these maps
 * are consulted only at SSE broadcast and replay-helper egress.
 */
export type LabelMap = Map<string, string>;

/**
 * Build a label map from raw attachment rows. Keys: realpath +
 * basename(realpath). Value: `<name> [#<id4>]`.
 *
 * `id` is sliced to 4 chars unconditionally — the post-hoc
 * disambiguation suffix doubles as a stable reference anchor in
 * conversation ("the abc1 file"). No collision detection.
 */
export function buildLabelMap(
  rows: Array<{ id: string; name: string; realpath: string }>,
): LabelMap {
  const m = new Map<string, string>();
  for (const r of rows) {
    const label = `${r.name} [#${r.id.slice(0, 4)}]`;
    m.set(r.realpath, label);
    const bn = basename(r.realpath);
    // Don't shadow an existing realpath entry. Realpaths are
    // absolute so collision with a basename is extremely rare; this
    // is defensive only.
    if (!m.has(bn)) m.set(bn, label);
  }
  return m;
}

/** Substring-replace each map key with its label. Longer keys first
 *  so the basename entry doesn't clobber a full-path occurrence. */
function rewriteString(s: string, map: LabelMap): string {
  if (map.size === 0) return s;
  // Sort keys descending by length: ensures e.g. `/a/b/file.pdf`
  // gets replaced before its `file.pdf` basename.
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  let out = s;
  for (const k of keys) {
    if (!out.includes(k)) continue;
    out = out.split(k).join(map.get(k) ?? "");
  }
  return out;
}

/**
 * Replace internal uuid attachment paths with user-visible labels
 * in the fields users see. Pure: returns a new event object when
 * any field changed, otherwise the original reference.
 *
 * Touched:
 *  - `tool_call.title`            (substring rewrite)
 *  - `tool_call.rawInput.path`    (exact-match replace)
 *  - `permission_request.title`   (substring rewrite)
 *
 * NOT touched (deliberate):
 *  - `permission_request.rawInput` — F2 interceptor
 *    (`attachment-interceptor.ts`) authoritatively reads this for
 *    realpath-equality auto-approve. Mutating it here would silently
 *    break the security gate even though enrich runs after the
 *    decision today; future read paths must not be poisoned.
 *  - `permission_request.locations[].path` — ACP protocol field,
 *    not user-visible in our UI.
 *  - `user_message.attachments[].displayName` — rendered as
 *    `<a class="user-file" download>` link, modality is different.
 *  - All other event types — pass through.
 */
export function enrichEventForDisplay(
  event: AgentEvent,
  map: LabelMap,
): AgentEvent {
  if (map.size === 0) return event;

  if (event.type === "tool_call") {
    const newTitle = rewriteString(event.title, map);
    let newRawInput = event.rawInput;
    if (
      event.rawInput &&
      typeof event.rawInput === "object" &&
      typeof event.rawInput.path === "string"
    ) {
      const replaced = map.get(event.rawInput.path);
      if (replaced) {
        newRawInput = { ...event.rawInput, path: replaced };
      }
    }
    if (newTitle !== event.title || newRawInput !== event.rawInput) {
      return { ...event, title: newTitle, rawInput: newRawInput };
    }
    return event;
  }

  if (event.type === "permission_request") {
    const newTitle = rewriteString(event.title, map);
    if (newTitle !== event.title) {
      return { ...event, title: newTitle };
    }
    return event;
  }

  return event;
}

/**
 * JSON-string variant of `enrichEventForDisplay` for the replay
 * path: `store.getEvents()` returns rows whose `data` is a JSON
 * string and whose `type` lives in a sibling column. Same chokepoint
 * spirit as `reSignAttachmentUrlsInJson` in auth.ts.
 *
 * Mutates `row.data` in place when enrichment changes anything
 * (returning the row unchanged otherwise).
 */
export function enrichStoredEventDataForDisplay(
  type: string,
  data: string,
  map: LabelMap,
): string {
  if (map.size === 0) return data;
  if (type !== "tool_call" && type !== "permission_request") return data;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return data;
  }
  // Synthesize a minimal event shape so we can reuse the object-level
  // enricher. `sessionId` etc. don't matter to enrich logic.
  const ev = { type, ...parsed } as unknown as AgentEvent;
  const out = enrichEventForDisplay(ev, map);
  if (out === ev) return data;
  // Strip the synthesized `type` to match the stored shape.
  const { type: _t, ...rest } = out as unknown as Record<string, unknown>;
  void _t;
  return JSON.stringify(rest);
}

/**
 * Replay-path egress chokepoint: rewrites each stored event row's
 * `data` field with attachment labels in place. Mutates rows.
 *
 * Use anywhere `store.getEvents` results are sent to clients
 * (history GET, share viewer). Live SSE goes through
 * `SseManager.sendEvent` which has its own object-level enricher.
 */
export function enrichStoredEventsForDisplay<
  T extends { type: string; data: string },
>(events: T[], map: LabelMap): T[] {
  if (map.size === 0) return events;
  for (const ev of events) {
    if (typeof ev.data === "string") {
      ev.data = enrichStoredEventDataForDisplay(ev.type, ev.data, map);
    }
  }
  return events;
}
