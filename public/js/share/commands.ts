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

  const trimmed = arg.trim();
  const parts = trimmed.split(/\s+/);
  const sub = (parts[0] ?? '').toLowerCase();

  if (sub === 'publish') return handlePublish();
  if (sub === 'discard') {
    addSystem('share: discard — preview will age out on TTL; use /share again to regenerate');
    previewToken = null;
    return true;
  }
  if (sub === 'list') return handleList();
  if (sub === 'revoke') {
    const token = parts[1];
    if (!token) {
      addSystem('share: usage — /share revoke <token>');
      return true;
    }
    return handleRevoke(token);
  }
  if (sub === 'label') {
    const token = parts[1];
    const label = trimmed.slice(('label '.length + (token?.length ?? 0)) + 1).trim();
    if (!token) {
      addSystem('share: usage — /share label <token> <new label>');
      return true;
    }
    return handleSetLabel(token, label);
  }
  if (sub !== '') {
    addSystem(`share: unknown subcommand '${sub}' — try /share, /share publish, /share list, /share revoke <token>, /share label <token> <text>, /share discard`);
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
      `  /share list                   — 查看所有 live shares\n` +
      `  /share revoke ${data.token}  — 撤销此链接`,
    );
    previewToken = null;
  } catch (err) {
    slog.error('publish error', { err });
    addSystem(`share: network error ${String(err)}`);
  }
  return true;
}

interface ShareListRow {
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

async function handleList(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/shares', { credentials: 'same-origin' });
    if (!res.ok) {
      addSystem(`share: list failed ${res.status}`);
      return true;
    }
    const data = await res.json() as { shares: ShareListRow[] };
    if (data.shares.length === 0) {
      addSystem('share list: (empty — no live shares)');
      return true;
    }
    const lines: string[] = ['share list:'];
    for (const s of data.shares) {
      const kind = s.shared_at == null ? 'preview' : 'active ';
      const label = s.owner_label ? ` [${s.owner_label}]` : '';
      const title = s.session_title ? ` "${s.session_title}"` : '';
      lines.push(`  ${kind}  ${s.token}  #${s.share_snapshot_seq}${title}${label}`);
    }
    lines.push('  /share revoke <token>         — 撤销');
    lines.push('  /share label <token> <text>   — 改 owner_label');
    addSystem(lines.join('\n'));
  } catch (err) {
    slog.error('list error', { err });
    addSystem(`share: network error ${String(err)}`);
  }
  return true;
}

async function handleRevoke(token: string): Promise<boolean> {
  // Look up session_id by listing; revoke hits a session-scoped endpoint.
  try {
    const lr = await fetch('/api/v1/shares', { credentials: 'same-origin' });
    if (!lr.ok) {
      addSystem(`share: revoke failed to resolve token (list=${lr.status})`);
      return true;
    }
    const data = await lr.json() as { shares: ShareListRow[] };
    const row = data.shares.find(s => s.token === token);
    if (!row) {
      addSystem(`share: token not found in live shares (already revoked?)`);
      return true;
    }
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(row.session_id)}/share`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      addSystem(`share: revoke failed ${res.status}`);
      return true;
    }
    const j = await res.json() as { revoked: boolean };
    addSystem(j.revoked ? `share: revoked ${token}` : `share: ${token} already revoked`);
  } catch (err) {
    slog.error('revoke error', { err });
    addSystem(`share: network error ${String(err)}`);
  }
  return true;
}

async function handleSetLabel(token: string, label: string): Promise<boolean> {
  try {
    const lr = await fetch('/api/v1/shares', { credentials: 'same-origin' });
    if (!lr.ok) { addSystem(`share: label failed to resolve token (list=${lr.status})`); return true; }
    const data = await lr.json() as { shares: ShareListRow[] };
    const row = data.shares.find(s => s.token === token);
    if (!row) { addSystem(`share: token not found`); return true; }
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(row.session_id)}/share`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, owner_label: label }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const t = await res.text();
      addSystem(`share: label failed ${res.status} — ${t.slice(0, 200)}`);
      return true;
    }
    const j = await res.json() as { owner_label: string | null };
    addSystem(`share: label set — ${token} → ${j.owner_label ?? '(cleared)'}`);
  } catch (err) {
    slog.error('label error', { err });
    addSystem(`share: network error ${String(err)}`);
  }
  return true;
}
