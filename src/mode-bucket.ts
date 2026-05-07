// Cross-agent ACP mode classification.
//
// Different agents emit `currentModeId` in different forms:
//   - Copilot CLI:   "https://agentclientprotocol.com/protocol/session-modes#autopilot"
//   - Claude Code:   "bypassPermissions" (bare camelCase string)
//   - Codex:         "read-only" / "auto" / "full-access" (bare hyphenated)
//   - Gemini CLI:    "default" / "autoEdit" / "yolo" / "plan" (bare; enum-based)
//   - OpenCode:      "build" / "plan" / "general" + user-defined agent names
//
// `extractModeId` normalizes URL forms into a short id. All bucket / display
// logic flows through `extractModeId`, so adding a new mode means adding one
// entry to one of the small constant sets below.
//
// Buckets webagent cares about:
//   - plan       → read-only; visual hint only, no permission interception
//   - autopilot  → all permission_requests auto-approved with `allow_once`
//   - default    → forwarded as-is to the user (anything that's neither plan nor autopilot)
//
// The agent's own internal modes (Claude acceptEdits/dontAsk/auto, Gemini
// autoEdit, OpenCode user-defined agents) all fall into the default bucket
// from webagent's perspective: the agent decides internally whether to emit
// a permission_request, and we just respond to what arrives.

const PLAN_IDS = new Set(["plan", "read-only"]);
const AUTOPILOT_IDS = new Set([
  "autopilot",
  "bypassPermissions",
  "full-access",
  "yolo",
]);

// IDs that should hide the pill entirely (the canonical "default" of each
// agent — showing it adds noise because it's the resting state).
//   - "agent"   → Copilot default
//   - "default" → Claude default + Gemini default
//   - "build"   → OpenCode default
const HIDDEN_DEFAULT_IDS = new Set(["agent", "default", "build"]);

export function extractModeId(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = raw.match(/[#/]([^#/]+)$/);
  return m ? m[1] : raw;
}

export function isPlanMode(raw: string | null | undefined): boolean {
  return PLAN_IDS.has(extractModeId(raw));
}

export function isAutopilotMode(raw: string | null | undefined): boolean {
  return AUTOPILOT_IDS.has(extractModeId(raw));
}

export function shouldShowModePill(raw: string | null | undefined): boolean {
  const id = extractModeId(raw);
  if (!id) return false;
  return !HIDDEN_DEFAULT_IDS.has(id);
}

// camelCase → "camel Case" (CSS `text-transform: uppercase` finishes the job).
// `bypassPermissions` → "bypass Permissions" → "BYPASS PERMISSIONS"
// `acceptEdits` → "accept Edits" → "ACCEPT EDITS"
// `plan` → "plan" → "PLAN"
export function formatModeLabel(raw: string | null | undefined): string {
  return extractModeId(raw)
    .replace(/([A-Z])/g, " $1")
    .trim();
}
