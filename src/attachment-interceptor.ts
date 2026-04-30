// Permission auto-approve interceptor for attachment reads.
//
// Plan §1.4 (uploads-plan v2.6, lines 105-183). When an agent requests
// permission to *read* a path that we know is one of the user-uploaded
// session attachments, auto-approve with `allow_once`. Any deviation
// from the strict allowlist falls through to the user prompt.
//
// Defenses (mirrored from the plan):
//   F1 kind === "read" only
//   F2 every locations[].path realpath ∈ session attachment realpaths
//   F4 schema gate — locations must exist; if rawInput has known path
//      keys they must also realpath into the attachment set; if it has
//      none, allow but bump schemaDrift counter so we notice when the
//      Copilot CLI changes its raw-input field names.
//   F6 any realpath / DB error → fall through (deny auto-approve, not
//      deny the user — the user dialog still shows)
//   F7 four counters, dumped hourly via attachInterceptorLogger.

import { realpath as fsRealpath } from "node:fs/promises";

const READ_TOOL_ALLOWLIST = new Set(["view", "read_file"]);
const RAWINPUT_PATH_KEYS = ["path", "filePath", "file"];

export interface InterceptorCounters {
  autoAllowed: number;
  fellThrough: number;
  realpathErrors: number;
  schemaDrift: number;
}

export interface InterceptorLogger {
  debug?: (msg: string, ctx?: Record<string, unknown>) => void;
  info?: (msg: string, ctx?: Record<string, unknown>) => void;
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  error?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface InterceptorEvent {
  sessionId: string;
  toolKind?: string;
  toolName?: string;
  locations?: { path: string; line?: number | null }[];
  rawInput?: Record<string, unknown>;
}

export interface InterceptorDeps {
  listAttachmentRealpaths: (sessionId: string) => string[];
  counters: InterceptorCounters;
  logger?: InterceptorLogger;
  /** Fired the first time schemaDrift increments per process; the caller
   *  uses this to log.error + push a one-shot system message (24h
   *  throttle handled by the caller). */
  onSchemaDrift?: (ctx: Record<string, unknown>) => void;
}

export function createCounters(): InterceptorCounters {
  return {
    autoAllowed: 0,
    fellThrough: 0,
    realpathErrors: 0,
    schemaDrift: 0,
  };
}

async function checkLocationPaths(
  locations: { path: string }[],
  attachmentRealpaths: Set<string>,
  counters: InterceptorCounters,
  log: InterceptorLogger,
  miss: (reason: string) => false,
): Promise<true | false> {
  for (const loc of locations) {
    let rp: string;
    try {
      rp = await fsRealpath(loc.path);
    } catch (e) {
      counters.realpathErrors++;
      log.warn?.("attachment interceptor realpath error", {
        path: loc.path,
        error: (e as NodeJS.ErrnoException).code ?? (e as Error).message,
      });
      return miss("realpath_failed");
    }
    if (!attachmentRealpaths.has(rp)) return miss("path_not_in_attachments");
  }
  return true;
}

async function checkRawInputPaths(
  raw: Record<string, unknown>,
  attachmentRealpaths: Set<string>,
  miss: (reason: string) => false,
): Promise<{ ok: true; foundAnyKey: boolean } | { ok: false; result: false }> {
  let foundAnyKey = false;
  for (const key of RAWINPUT_PATH_KEYS) {
    const v = raw[key];
    if (typeof v !== "string") continue;
    foundAnyKey = true;
    let rp: string;
    try {
      rp = await fsRealpath(v);
    } catch {
      return { ok: false, result: miss("rawinput_realpath_failed") };
    }
    if (!attachmentRealpaths.has(rp)) {
      return { ok: false, result: miss("rawinput_path_mismatch") };
    }
  }
  return { ok: true, foundAnyKey };
}

/**
 * Returns true iff the request matches the strict
 * "agent reading a known session attachment" pattern.
 *
 * Returning false does NOT deny the user prompt — it just declines to
 * auto-approve, so the normal permission UI continues to render.
 */
export async function shouldAutoApproveAttachmentRead(
  ev: InterceptorEvent,
  deps: InterceptorDeps,
): Promise<boolean> {
  const { counters, logger } = deps;
  const log = logger ?? {};

  const miss = (reason: string): false => {
    counters.fellThrough++;
    log.debug?.("attachment auto-allow miss", {
      reason,
      sessionId: ev.sessionId,
      toolKind: ev.toolKind,
      toolName: ev.toolName,
    });
    return false;
  };

  if (ev.toolKind !== "read") return miss("tool_kind_not_read");
  if (
    typeof ev.toolName === "string" &&
    !READ_TOOL_ALLOWLIST.has(ev.toolName)
  ) {
    return miss("tool_name_not_allowlisted");
  }
  if (!Array.isArray(ev.locations) || ev.locations.length === 0) {
    return miss("no_locations");
  }

  let attachmentRealpaths: Set<string>;
  try {
    attachmentRealpaths = new Set(deps.listAttachmentRealpaths(ev.sessionId));
  } catch (e) {
    log.warn?.("attachment interceptor db error", {
      sessionId: ev.sessionId,
      error: (e as Error).message,
    });
    return miss("db_error");
  }

  const locOk = await checkLocationPaths(
    ev.locations,
    attachmentRealpaths,
    counters,
    log,
    miss,
  );
  if (locOk !== true) return locOk;

  const raw = ev.rawInput;
  if (raw && typeof raw === "object") {
    const r = await checkRawInputPaths(raw, attachmentRealpaths, miss);
    if (!r.ok) return r.result;
    if (!r.foundAnyKey) {
      counters.schemaDrift++;
      log.warn?.(
        "attachment interceptor schema drift: rawInput has no known path key",
        { rawInputKeys: Object.keys(raw) },
      );
      deps.onSchemaDrift?.({ rawInputKeys: Object.keys(raw) });
    }
  }

  counters.autoAllowed++;
  log.info?.("attachment auto-allowed", {
    sessionId: ev.sessionId,
    toolKind: ev.toolKind,
    toolName: ev.toolName,
    locations: ev.locations.map((l) => l.path),
  });
  return true;
}
