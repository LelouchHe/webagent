/**
 * Sanitize events for sharing (share-plan §4.3 / Layer1).
 *
 * Two-stage deterministic scan, run write-time (gate) and read-time
 * (re-sanitize for each public request so rule upgrades apply to old
 * shares). No blob, no `sanitizer_version` field in DB — rules are
 * const pure functions, `SANITIZER_VERSION` is projection-cache key only.
 *
 *   Layer 1a — structured rewrite (zero false-positive):
 *     - homedir → "<home>"
 *     - cwd     → "<cwd>"
 *     - internal_hosts[i] → "<internal-host>"
 *
 *   Layer 1c — hard reject (throws SanitizeError with event_id):
 *     - OpenSSH/PEM private keys (any format)
 *     - `github_pat_...` and `ghp_...`
 *     - `aws_secret_access_key=...`
 *
 *   Layer 1b (flag/redact) is intentionally minimal in v1 per plan §4.3.
 *   Entropy-based token detection is out of scope; Layer 3 (owner preview +
 *   revoke) is the main defense.
 *
 * XSS defense (scripts, js: URIs, event handlers) is the viewer's job
 * via route-level CSP + DOMPurify on markdown render. Sanitize.ts does
 * NOT escape HTML — raw text flows through to the viewer which renders
 * with html:false / DOMPurify.
 */
import type { StoredEvent } from "../types.ts";

export const SANITIZER_VERSION = "2026-04-24";

/**
 * Input event shape — either a raw StoredEvent (with JSON-string data)
 * or a pre-parsed event. Sanitizer normalizes internally.
 */
export type SanitizeInputEvent = StoredEvent | ParsedEvent;

/** Parsed / output event shape: data decoded to plain object. */
export interface ParsedEvent {
  id?: number;
  session_id?: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  created_at?: string;
}

export interface SanitizeInput {
  events: SanitizeInputEvent[];
  cwd: string;
  homeDir: string;
  internalHosts: string[];
}

export interface SanitizeResult {
  events: ParsedEvent[];
  flags: SanitizeFlag[];
}

export interface SanitizeFlag {
  seq: number;
  kind: "email" | "absolute_path" | "uuid" | "high_entropy";
  excerpt: string;
}

export class SanitizeError extends Error {
  readonly status = 400;
  /** The event seq that triggered the hard-reject; surfaced to owner as event_id. */
  readonly event_id: number;
  readonly rule: string;
  constructor(event_id: number, rule: string, message: string) {
    super(message);
    this.event_id = event_id;
    this.rule = rule;
  }
}

// --- Layer 1c: hard-reject patterns ---
//
// Order matters only for error messages; any match aborts. Patterns are
// designed to be low-false-positive (we're looking for obvious leakage,
// not heuristic secrets — those belong to Layer 1b).
const HARD_REJECT_RULES: Array<{ id: string; pattern: RegExp; msg: string }> = [
  {
    id: "private_key",
    pattern: /-----BEGIN (?:OPENSSH |RSA |EC |DSA |)PRIVATE KEY-----/,
    msg: "private key detected",
  },
  { id: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, msg: "GitHub PAT detected" },
  { id: "github_ghp", pattern: /\bghp_[A-Za-z0-9]{20,}\b/, msg: "GitHub classic token detected" },
  {
    id: "aws_secret",
    pattern: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,}/i,
    msg: "AWS secret access key detected",
  },
];

/**
 * Escape a string for safe inclusion in a RegExp. Needed for the homedir
 * / cwd rewrite where paths may contain regex metachars (mac paths don't
 * in practice, but defense in depth).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Layer 1a: structured rewrite on a single string.
 *
 * Runs homedir/cwd first (longer match wins), then internal_hosts. The
 * order is important — cwd often starts with homedir, and rewriting
 * homedir first would leave "<home>/rest/of/cwd" un-collapsed. We
 * rewrite cwd before homedir to catch that.
 */
function rewriteStructured(
  s: string,
  cwd: string,
  homeDir: string,
  internalHosts: string[],
): string {
  let out = s;
  // cwd first (usually longer / more specific than homedir)
  if (cwd) out = out.replace(new RegExp(escapeRegExp(cwd), "g"), "<cwd>");
  if (homeDir) out = out.replace(new RegExp(escapeRegExp(homeDir), "g"), "<home>");
  for (const host of internalHosts) {
    if (!host) continue;
    out = out.replace(new RegExp(escapeRegExp(host), "g"), "<internal-host>");
  }
  return out;
}

/** Hard-reject scan on a string. Throws SanitizeError on first match. */
function assertNoHardRejects(seq: number, s: string): void {
  for (const rule of HARD_REJECT_RULES) {
    if (rule.pattern.test(s)) {
      throw new SanitizeError(seq, rule.id, rule.msg);
    }
  }
}

/**
 * Sanitize a single StoredEvent. Rewrite applied in-place on a cloned
 * JSON shape; hard-reject check runs on the stringified raw form so
 * nested fields are all scanned without a schema enumeration.
 */
function sanitizeEvent(
  event: SanitizeInputEvent,
  cwd: string,
  homeDir: string,
  internalHosts: string[],
): ParsedEvent {
  // Normalize: if .data is a JSON string (StoredEvent), parse it.
  let parsedData: Record<string, unknown>;
  if (typeof event.data === "string") {
    try {
      parsedData = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      parsedData = {};
    }
  } else {
    parsedData = event.data;
  }

  // Hard-reject scan runs on pre-rewrite stringified form so the rules
  // see the actual payload rather than the "<home>"-scrubbed version.
  const raw = JSON.stringify(parsedData);
  assertNoHardRejects(event.seq, raw);

  const rewrittenData = deepRewriteStrings(parsedData, (s) =>
    rewriteStructured(s, cwd, homeDir, internalHosts),
  ) as Record<string, unknown>;

  return {
    id: "id" in event ? event.id : undefined,
    session_id: "session_id" in event ? event.session_id : undefined,
    seq: event.seq,
    type: event.type,
    data: rewrittenData,
    created_at: "created_at" in event ? event.created_at : undefined,
  };
}

function deepRewriteStrings(value: unknown, rewrite: (s: string) => string): unknown {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value)) return value.map((v) => deepRewriteStrings(v, rewrite));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepRewriteStrings(v, rewrite);
    }
    return out;
  }
  return value;
}

/**
 * Main entry — sanitize a batch of events for share output.
 *
 * Throws SanitizeError with event_id on Layer-1c hard-reject (owner gets
 * 4xx + event_id so they can jump to the offending event).
 */
export function sanitizeEventsForShare(input: SanitizeInput): SanitizeResult {
  const out: ParsedEvent[] = [];
  for (const ev of input.events) {
    out.push(sanitizeEvent(ev, input.cwd, input.homeDir, input.internalHosts));
  }
  return { events: out, flags: [] };
}
