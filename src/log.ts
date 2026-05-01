// Backend logger — mirror of `public/js/log.ts`, single-knob level-gated.
//
// Single axis:
//   level: off | debug | info | warn | error
//
// `off` short-circuits with a single boolean read (zero cost when disabled).
// For any other level, records at or above the threshold are written to
// stdout (debug/info) or stderr (warn/error), formatted as:
//   HH:MM:SS.mmm LEVEL [scope] msg {fields-json}\n
//
// Format and `safeStringify` are shared with the frontend via `./log-fmt.ts`,
// keeping the two emit paths in sync.
//
// Tests can hook the output via `setLogSink((stream, line) => ...)`. In
// production this is unset and writes go straight to `process.stdout` /
// `process.stderr`.

import type { Logger } from "./types.ts";
import {
  LEVEL_RANK,
  VALID_LEVELS,
  safeStringify,
  formatTs,
} from "./log-fmt.ts";
import type { LogLevel } from "./log-fmt.ts";

export type { LogLevel };

// ============================================================
// Module state
// ============================================================

let currentLevel: LogLevel = "off";

type Sink = (stream: "out" | "err", line: string) => void;
let sink: Sink | null = null;

// ============================================================
// Public API
// ============================================================

export function setLogLevel(level: LogLevel): void {
  if (!VALID_LEVELS.has(level)) return;
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Install a custom sink (test hook). Pass `null` to restore stdout/stderr. */
export function setLogSink(fn: Sink | null): void {
  sink = fn;
}

// ============================================================
// Logger implementation
// ============================================================

function make(parentScope?: string): Logger {
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    // Zero-overhead gate: must be the first statement.
    if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) {
      return;
    }
    const ts = formatTs(Date.now());
    const scopePart = parentScope ? ` [${parentScope}]` : "";
    const fieldsPart = fields !== undefined ? " " + safeStringify(fields) : "";
    const line = `${ts}${scopePart} ${level.toUpperCase()} ${msg}${fieldsPart}\n`;
    const stream: "out" | "err" =
      level === "warn" || level === "error" ? "err" : "out";
    try {
      if (sink) {
        sink(stream, line);
      } else if (stream === "err") {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    } catch {
      // never let logger internals throw to caller
    }
  };

  return {
    debug: (m, f) => {
      emit("debug", m, f);
    },
    info: (m, f) => {
      emit("info", m, f);
    },
    warn: (m, f) => {
      emit("warn", m, f);
    },
    error: (m, f) => {
      emit("error", m, f);
    },
    scope: (n) => make(parentScope ? `${parentScope}.${n}` : n),
  };
}

export const log: Logger = make();
