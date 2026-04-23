// In-page debug log — single-knob level-gated logger.
//
// Single axis:
//   level: off | debug | info | warn | error
//
// `off` short-circuits with a single boolean read (zero cost when disabled).
// For any other level, records at or above the threshold emit to BOTH the
// DevTools console AND the inline renderer (if set). No separate `visible`
// flag — desktop users can skip DevTools, mobile users get DOM output for
// free, one mental model.
//
// The `setLogLevel` setter is the only runtime API. Callers:
//   - URL boot override: `parseUrlLogLevel()` reads `?debug=<level>` and
//     is invoked once at module load.
//   - Server config: the `connected` SSE event carries `debugLevel`; the
//     connection handler calls `setLogLevel` with `urlLevel ?? configLevel`.
//   - `/debug <level>` slash command: calls `setLogLevel` at runtime.
//
// Logger always forwards to native `console.*` for DevTools call-site line
// numbers. No `console.*` monkey-patch.

import type { Logger, LogRecord } from "../../src/types.ts";

// ============================================================
// Types + constants
// ============================================================

export type LogLevel = "off" | "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  off: 99,
};

const FIELD_CAP_BYTES = 4096;

// ============================================================
// Module state
// ============================================================

let currentLevel: LogLevel = "off";

type AddSystemFn = (text: string) => HTMLElement;
let addSystemImpl: AddSystemFn | null = null;

// ============================================================
// Public API
// ============================================================

const VALID_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "off",
  "debug",
  "info",
  "warn",
  "error",
]);

export function setLogLevel(level: LogLevel): void {
  if (!VALID_LEVELS.has(level)) return;
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Apply the initial log level from the server's `connected` payload, honoring
 * any `?debug=<level>` URL override. Callers from both SSE and handleEvent
 * paths use this to install the level once per connection.
 */
export function applyConnectedLogLevel(configLevel: string | undefined): void {
  const urlLevel = parseUrlLogLevel();
  if (urlLevel) {
    setLogLevel(urlLevel);
    return;
  }
  if (configLevel && VALID_LEVELS.has(configLevel)) {
    setLogLevel(configLevel as LogLevel);
  } else {
    setLogLevel("off");
  }
}

export function setLogRenderer(fn: AddSystemFn): void {
  addSystemImpl = fn;
}

export function setLogContextProvider(_fn: () => { sessionId?: string }): void {
  // No-op in inline mode; kept for API compatibility with callers that may
  // set a session-context provider ahead of a future server-log bridge.
}

/**
 * Parse a log level from a URL. Returns the level if `?debug=<level>` is
 * present with a valid value, otherwise null. Used at boot to honor URL
 * override before the `connected` event arrives.
 */
export function parseUrlLogLevelFrom(url: string): LogLevel | null {
  try {
    const u = new URL(url);
    const raw = u.searchParams.get("debug");
    if (raw === null) return null;
    if (!VALID_LEVELS.has(raw)) return null;
    return raw as LogLevel;
  } catch {
    return null;
  }
}

export function parseUrlLogLevel(): LogLevel | null {
  if (typeof location === "undefined") return null;
  return parseUrlLogLevelFrom(location.href);
}

// Backward-compat no-op retained so callers wired before the level refactor
// (e.g. tests that clear per-session DOM) don't break.
export function resetForSession(): void {
  // intentionally empty — inline messages live in #messages and are cleared by resetSessionUI.
}

// ============================================================
// Logger implementation
// ============================================================

function make(parentScope?: string): Logger {
  const emit = (level: LogRecord["level"], msg: string, fields?: Record<string, unknown>): void => {
    // Zero-overhead gate: must be the first statement.
    if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) {
      return;
    }
    const prefix = parentScope ? `[${parentScope}] ` : "";
    try {
      // eslint-disable-next-line no-console
      const out = console[level] as (...a: unknown[]) => void;
      if (fields !== undefined) {
        out(prefix + msg, fields);
      } else {
        out(prefix + msg);
      }
    } catch {
      // ignore
    }
    if (!addSystemImpl) return;
    try {
      const ts = formatTs(Date.now());
      const scopePart = parentScope ? ` [${parentScope}]` : "";
      const fieldsPart = fields !== undefined ? " " + safeStringify(fields) : "";
      addSystemImpl(`${ts}${scopePart} ${level.toUpperCase()} ${msg}${fieldsPart}`);
    } catch {
      // never let logger internals throw to caller
    }
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    scope: (n) => make(parentScope ? `${parentScope}.${n}` : n),
  };
}

export const log: Logger = make();

// ============================================================
// Bootstrap: honor ?debug=<level> immediately on module load.
// ============================================================

{
  const urlLevel = parseUrlLogLevel();
  if (urlLevel) setLogLevel(urlLevel);
}

// ============================================================
// safeStringify
// ============================================================

function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const str = JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack };
      }
      if (typeof v === "function") {
        const fn = v as { name?: string };
        return `[Function ${fn.name ?? "anonymous"}]`;
      }
      if (typeof v === "bigint") return v.toString() + "n";
      if (typeof v === "symbol") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
    if (typeof str !== "string") return String(value);
    if (str.length > FIELD_CAP_BYTES) {
      return str.slice(0, FIELD_CAP_BYTES) + `…(truncated, ${str.length} bytes)`;
    }
    return str;
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
function pad3(n: number): string {
  return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
}
function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

// ============================================================
// Window error hooks (registered once at module load)
// ============================================================

if (typeof window !== "undefined") {
  const winLog = log.scope("window");
  window.addEventListener("error", (e: ErrorEvent) => {
    winLog.error(e.message || "uncaught error", {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason: unknown = e.reason;
    winLog.error("unhandled rejection", {
      reason:
        reason instanceof Error
          ? { name: reason.name, message: reason.message, stack: reason.stack }
          : reason,
    });
  });
}
