// Share UI helpers — owner-side preview/publish/discard/list/revoke.
//
// Per /share v1.1 spec (locked):
//   • `/share` (no arg)   → list active shares; Enter = create new preview
//   • `/share revoke <t>` → revoke a public share
//   • Preview mode (set by createPreview): menu switches to PREVIEW_ROOT,
//     only `/publish` and `/discard` are accepted. Other slash commands
//     reply "share: in preview mode — /publish or /discard first".
//   • Discard does NOT call backend — TTL cleans the unused preview row.
//   • Page refresh / session switch loses previewToken (resetSessionUI
//     clears it); the backend preview row TTLs out the same way.
//
// All mutating endpoints live under `/api/v1/sessions/:id/share*` and
// `/api/v1/shares` — gated by Bearer via the global authFetch monkey-patch.
// Viewer endpoints (`/s/:token`, `/api/v1/shared/:token/events`) are public
// and never touched from owner code.

import { state } from "../state.ts";
import { updateModeUI } from "../state.ts";
import { addSystem } from "../render.ts";
import { log } from "../log.ts";

const slog = log.scope("share");

interface PreviewResponse {
  token: string;
  session_id: string;
  snapshot_seq: number;
  ttl_hours: number | null;
  display_name: string | null;
  owner_label: string | null;
  shared_at: number | null;
  reused: boolean;
}

interface PublishResponse {
  token: string;
  shared_at: number;
  public_url: string;
  display_name: string | null;
}

export interface ShareListRow {
  token: string;
  session_id: string;
  session_title: string | null;
  shared_at: number | null;
  created_at: number;
  display_name: string | null;
  owner_label: string | null;
  share_snapshot_seq: number;
  ttl_hours: number | null;
  last_accessed_at: number | null;
}

function previewUrl(token: string): string {
  return `${location.origin}/s/${token}?preview=${token}`;
}

function publicUrl(rawPath: string, token: string): string {
  if (rawPath.startsWith("http")) return rawPath;
  if (rawPath) return `${location.origin}${rawPath}`;
  return `${location.origin}/s/${token}`;
}

/**
 * POST /api/v1/sessions/:id/share — create (or reuse) a preview snapshot.
 * On success: sets `state.previewToken` so the slash menu switches to
 * PREVIEW_ROOT and prints an inline owner-side report.
 */
export async function createPreview(): Promise<void> {
  if (!state.sessionId) {
    addSystem("share: no active session");
    return;
  }
  const sessionId = state.sessionId;
  try {
    const res = await fetch(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/share`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        credentials: "same-origin",
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 409) {
        addSystem(
          "share: session busy (agent streaming) — retry after the response completes",
        );
      } else if (res.status === 403) {
        addSystem("share: forbidden (not owner)");
      } else if (res.status === 400 && errText.includes("sanitize")) {
        addSystem(`share: ✗ sanitize blocked this session — ${errText}`);
      } else {
        addSystem(
          `share: create failed ${res.status} — ${errText.slice(0, 200)}`,
        );
      }
      return;
    }
    const data = (await res.json()) as PreviewResponse;
    state.previewToken = data.token;
    updateModeUI();

    const action = data.reused ? "reused" : "ready";
    addSystem(
      `preview ${action}:\n` +
        `  token         ${data.token}\n` +
        `  preview URL   ${previewUrl(data.token)}     (only you can see this)\n` +
        `\n` +
        `  /publish    freeze and make public\n` +
        `  /discard    drop this preview\n` +
        `\n` +
        `  to keep chatting, open this session in a new tab`,
    );
  } catch (err) {
    slog.error("preview create error", { err });
    addSystem(`share: network error — ${String(err)}`);
  }
}

/**
 * POST /api/v1/sessions/:id/share/publish — freeze the active preview.
 * Failure keeps preview mode active so the user can retry or `/discard`.
 */
export async function publishPreview(): Promise<void> {
  if (!state.sessionId) {
    addSystem("share: no active session");
    return;
  }
  if (!state.previewToken) {
    addSystem("share: no preview to publish — run /share first");
    return;
  }
  const sessionId = state.sessionId;
  const token = state.previewToken;
  try {
    const res = await fetch(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/share/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "same-origin",
      },
    );
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) {
        addSystem("share: forbidden (not owner)");
      } else if (res.status === 404) {
        addSystem("share: token not found (already revoked?)");
      } else {
        addSystem(
          `share: publish failed ${res.status} — ${text.slice(0, 200)}`,
        );
      }
      return;
    }
    const data = (await res.json()) as PublishResponse;
    const url = publicUrl(data.public_url, data.token);
    state.previewToken = null;
    updateModeUI();
    addSystem(
      `share published:\n` +
        `  public URL    ${url}\n` +
        `  token         ${data.token}\n` +
        `\n` +
        `  ›  /share revoke ${data.token}    take this link down`,
    );
  } catch (err) {
    slog.error("publish error", { err });
    addSystem(`share: network error — ${String(err)}`);
  }
}

/**
 * Drop the in-memory preview token. The backend row is left to TTL prune;
 * we deliberately don't call DELETE so a click slip doesn't burn a slot.
 */
export function discardPreview(): void {
  if (!state.previewToken) {
    addSystem("share: no preview active");
    return;
  }
  state.previewToken = null;
  updateModeUI();
  addSystem("share: preview dropped");
}

/**
 * GET /api/v1/shares — list active (published) shares for current owner.
 * Preview rows (shared_at == null) are filtered out so they never leak
 * into the menu / list view.
 */
export async function listOwnerShares(): Promise<ShareListRow[]> {
  const res = await fetch("/api/v1/shares", { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`list failed ${res.status}`);
  }
  const data = (await res.json()) as { shares: ShareListRow[] };
  return data.shares.filter((s) => s.shared_at != null);
}

/**
 * Revoke a public share. We need the row's session_id so look it up via
 * the list endpoint first; preview-only rows (shared_at == null) are
 * intentionally not revocable through here — they only TTL out.
 */
export async function revokeShare(token: string): Promise<void> {
  if (!token) {
    addSystem("share: usage — /share revoke <token>");
    return;
  }
  try {
    const all = await fetchAllSharesForRevoke();
    const row = all.find((s) => s.token === token);
    if (!row) {
      addSystem("share: token not found (already revoked?)");
      return;
    }
    const res = await fetch(
      `/api/v1/sessions/${encodeURIComponent(row.session_id)}/share`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "same-origin",
      },
    );
    if (!res.ok) {
      if (res.status === 403) addSystem("share: forbidden (not owner)");
      else if (res.status === 404) addSystem(`share: ${token} already revoked`);
      else addSystem(`share: revoke failed ${res.status}`);
      return;
    }
    const j = (await res.json()) as { revoked: boolean };
    addSystem(
      j.revoked ? `share: revoked ${token}` : `share: ${token} already revoked`,
    );
  } catch (err) {
    slog.error("revoke error", { err });
    addSystem(`share: network error — ${String(err)}`);
  }
}

// Revoke needs the full list (including any active rows the caller may
// have for other sessions); listOwnerShares already filters that, so this
// internal helper hits the raw endpoint.
async function fetchAllSharesForRevoke(): Promise<ShareListRow[]> {
  const res = await fetch("/api/v1/shares", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`list failed ${res.status}`);
  const data = (await res.json()) as { shares: ShareListRow[] };
  return data.shares.filter((s) => s.shared_at != null);
}
