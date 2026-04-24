// Share viewer — read-only public viewer for a session snapshot.
// Bundled standalone: marked + DOMPurify are imported (self-hosted, no CDN).
// Renders against the same DOM classes as the main app so styles.css carries
// over, minus any interaction surfaces (input bar, toolbars, buttons).

import { marked } from "marked";
import DOMPurify from "dompurify";
import { interpretToolCall, extractToolCallContent, getStatusIcon, formatPlanEntries } from "../event-interpreter.ts";
import type { StoredEvent, ToolContentItem } from "../../../src/types.ts";

interface SharePayload {
  schema_version: string;
  share: {
    token: string;
    session_title: string | null;
    snapshot_seq: number;
    shared_at: string | null;
    display_name: string | null;
    created_at: string;
  };
  events: StoredEvent[];
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// Parse event.data — StoredEvent.data is JSON string over the wire.
function parseData(ev: StoredEvent): Record<string, unknown> {
  if (typeof ev.data === "string") {
    try { return JSON.parse(ev.data) as Record<string, unknown>; } catch { return {}; }
  }
  return (ev.data ?? {}) as Record<string, unknown>;
}

function renderMarkdown(text: string, token: string): string {
  const html = marked.parse(text, { async: false }) as string;
  // Layer 2 defense (Layer 1a/1c already ran on the backend).
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
    FORBID_TAGS: ["style", "iframe", "form", "math", "svg"],
  });
  // Image URL rewrite: any /api/v1/sessions/.../images/X -> /s/:token/images/X.
  return clean.replace(
    /\/api\/v1\/sessions\/[^/"']+\/images\/([A-Za-z0-9._-]+)/g,
    `/s/${encodeURIComponent(token)}/images/$1`,
  );
}

function renderEvent(ev: StoredEvent, token: string, host: HTMLElement): void {
  const d = parseData(ev);
  const row = el("div", `msg msg-${ev.type}`);
  row.dataset.seq = String(ev.seq);

  switch (ev.type) {
    case "user_message": {
      const text = typeof d.text === "string" ? d.text : "";
      row.classList.add("user-msg");
      const body = el("div", "msg-body");
      body.textContent = text;
      row.appendChild(body);
      host.appendChild(row);
      break;
    }
    case "assistant_message": {
      const text = typeof d.text === "string" ? d.text : "";
      row.classList.add("assistant-msg");
      const body = el("div", "msg-body md");
      body.innerHTML = renderMarkdown(text, token); // xss-ok: DOMPurify + Layer1/Layer2
      row.appendChild(body);
      host.appendChild(row);
      break;
    }
    case "thinking": {
      const text = typeof d.text === "string" ? d.text : "";
      row.classList.add("thinking");
      row.appendChild(el("div", "msg-body", text));
      host.appendChild(row);
      break;
    }
    case "tool_call": {
      const kind = typeof d.kind === "string" ? d.kind : "";
      const title = typeof d.title === "string" ? d.title : "";
      const view = interpretToolCall(kind, title, d.rawInput as never);
      row.classList.add("tool-call", "pending");
      row.appendChild(el("span", "tool-icon", view.icon));
      row.appendChild(el("span", "tool-title", view.title));
      if (view.detail) row.appendChild(el("span", "tool-detail", `${view.detailPrefix ?? ""}${view.detail}`));
      host.appendChild(row);
      break;
    }
    case "tool_call_update": {
      const status = typeof d.status === "string" ? d.status : "pending";
      const content = Array.isArray(d.content) ? (d.content as ToolContentItem[]) : [];
      const text = extractToolCallContent(content);
      const { icon, className } = getStatusIcon(status);
      row.className = `msg msg-tool_call_update ${className}`;
      row.appendChild(el("span", "tool-icon", icon));
      if (text) row.appendChild(el("pre", "tool-output", text));
      host.appendChild(row);
      break;
    }
    case "plan": {
      const entries = Array.isArray(d.entries) ? formatPlanEntries(d.entries as never) : [];
      row.classList.add("plan");
      const ul = el("ul", "plan-list");
      for (const p of entries) {
        const li = el("li", "plan-item");
        li.appendChild(el("span", "plan-symbol", p.symbol));
        li.appendChild(el("span", "plan-content", p.content));
        ul.appendChild(li);
      }
      row.appendChild(ul);
      host.appendChild(row);
      break;
    }
    default:
      // Unknown event types: skip rather than render raw JSON (avoid shape leaks).
      return;
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch { return iso; }
}

async function main(): Promise<void> {
  // Set theme without an inline script (CSP: no unsafe-inline).
  try {
    const t = localStorage.getItem("theme") || "auto";
    document.documentElement.setAttribute("data-theme", t);
  } catch { /* ignore storage failures */ }

  const m = /^\/s\/([A-Za-z0-9_-]{24})(?:[/?#]|$)/.exec(location.pathname);
  if (!m) { document.body.textContent = "invalid share URL"; return; }
  const token = m[1];

  const infoEl = document.getElementById("session-info");
  const messagesEl = document.getElementById("messages");
  const footerMetaEl = document.querySelector(".share-footer-meta");
  if (!messagesEl) return;

  let payload: SharePayload;
  try {
    const res = await fetch(`/api/v1/shared/${encodeURIComponent(token)}/events`, {
      headers: { "Accept": "application/json" },
      credentials: "omit",
    });
    if (res.status === 410) { document.body.innerHTML = "<div class='share-gone'>此链接已撤销或过期。</div>"; return; } // xss-ok: static literal
    if (!res.ok) { document.body.textContent = `error ${res.status}`; return; }
    payload = await res.json() as SharePayload;
  } catch (err) {
    document.body.textContent = `failed to load: ${String(err)}`;
    return;
  }

  document.title = payload.share.session_title
    ? `${payload.share.session_title} — shared`
    : "shared session";

  if (infoEl) {
    const name = payload.share.display_name ?? "";
    const title = payload.share.session_title ?? "(untitled)";
    infoEl.textContent = name ? `shared by ${name} · ${title}` : title;
  }

  for (const ev of payload.events) {
    renderEvent(ev, token, messagesEl);
  }

  if (footerMetaEl) {
    footerMetaEl.textContent = `snapshot #${payload.share.snapshot_seq} · ${formatTimestamp(payload.share.shared_at ?? payload.share.created_at)}`;
  }
}

void main();
