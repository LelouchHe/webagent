// Shared log formatting utilities used by both the frontend (`public/js/log.ts`)
// and the backend (`src/log.ts`). Keeping a single source of truth here avoids
// drift between the two emit paths (level rank, timestamp format, structured
// field stringification).

export type LogLevel = "off" | "debug" | "info" | "warn" | "error";

export const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  off: 99,
};

export const VALID_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "off",
  "debug",
  "info",
  "warn",
  "error",
]);

const FIELD_CAP_BYTES = 4096;

export function safeStringify(value: unknown): string {
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
      return (
        str.slice(0, FIELD_CAP_BYTES) + `…(truncated, ${str.length} bytes)`
      );
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

export function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}
