// Share UI — /share slash command surface. Minimal v1: creates a preview,
// shows a terminal-style inline report with token, snapshot_seq, staleness,
// and publish/discard actions. The full viewer is a separate standalone
// page at /s/:token; this module only handles owner-side preview flow.

import { state } from '../state.ts';
import { addSystem } from '../render.ts';
import { log } from '../log.ts';

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

interface PreviewReadResponse {
  schema_version: string;
  share: {
    token: string;
    session_id: string;
    snapshot_seq: number;
    current_last_seq: number;
    events_since_snapshot: number;
    shared_at: number | null;
    display_name: string | null;
  };
  events: unknown[];
  cache_hit: boolean;
}

interface PublishResponse {
  token: string;
  shared_at: number;
  public_url: string;
  display_name: string | null;
}

const slog = log.scope('share');

/**
 * Handle `/share` — creates a preview and renders an owner-side report.
 * Sub-commands:
 *   /share              → create preview + inline report
 *   /share publish      → publish the active preview (requires prior /share)
 *   /share discard      → noop for now (row stays until TTL prune); flagged in UX doc
 */
export async function handleShareCommand(arg: string): Promise<boolean> {
  if (!state.sessionId) {
    addSystem('share: no active session');
    return true;
  }

  const sub = arg.trim().toLowerCase();
  if (sub === 'publish') {
    return handlePublish();
  }
  if (sub === 'discard') {
    addSystem('share: discard — preview will age out on TTL; use /share again to regenerate');
    previewToken = null;
    return true;
  }
  if (sub !== '') {
    addSystem(`share: unknown subcommand '${sub}' — try /share, /share publish, /share discard`);
    return true;
  }

  return handleCreatePreview();
}

let previewToken: string | null = null;

async function handleCreatePreview(): Promise<boolean> {
  const sessionId = state.sessionId!;
  try {
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 409) {
        addSystem('share: session busy (agent streaming) — retry after the current response completes');
      } else if (res.status === 400 && errText.includes('sanitize')) {
        addSystem(`share: ✗ sanitize blocked this session — ${errText}`);
      } else {
        addSystem(`share: create failed ${res.status} — ${errText.slice(0, 200)}`);
      }
      return true;
    }
    const data = await res.json() as PreviewResponse;
    previewToken = data.token;

    // Fetch the read-side to show staleness metadata (events_since_snapshot).
    const rd = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/share/preview`, {
      headers: { 'X-Share-Token': data.token },
      credentials: 'same-origin',
    });
    let staleLine = '';
    if (rd.ok) {
      const pv = await rd.json() as PreviewReadResponse;
      const since = pv.share.events_since_snapshot;
      staleLine = since > 0
        ? `\n  ⚠ 快照锚在 #${pv.share.snapshot_seq};之后新增 ${since} 条 events 不在此 preview 内`
        : `\n  ✓ 快照为最新(无新增 events)`;
    }

    const action = data.reused ? 'reused' : 'created';
    addSystem(
      `share preview ${action}:\n` +
      `  token:        ${data.token}\n` +
      `  snapshot_seq: #${data.snapshot_seq}` +
      staleLine + `\n` +
      `  状态:          preview(未 publish,仅你能看)\n` +
      `  /share publish  — 冻结此快照,生成公开链接\n` +
      `  /share discard  — 丢弃此 preview`,
    );
  } catch (err) {
    slog.error('preview create error', { err });
    addSystem(`share: network error ${String(err)}`);
  }
  return true;
}

async function handlePublish(): Promise<boolean> {
  if (!previewToken) {
    addSystem('share: no preview to publish — run /share first');
    return true;
  }
  const sessionId = state.sessionId!;
  try {
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/share/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: previewToken }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const text = await res.text();
      addSystem(`share: publish failed ${res.status} — ${text.slice(0, 200)}`);
      return true;
    }
    const data = await res.json() as PublishResponse;
    const url = data.public_url.startsWith('http')
      ? data.public_url
      : `${location.origin}${data.public_url}`;
    addSystem(
      `share published:\n` +
      `  public URL: ${url}\n` +
      `  token:      ${data.token}\n` +
      `  (链接是只读快照;撤销请用 /share list 找到后删除 — C4 提供)`,
    );
    previewToken = null;
  } catch (err) {
    slog.error('publish error', { err });
    addSystem(`share: network error ${String(err)}`);
  }
  return true;
}
