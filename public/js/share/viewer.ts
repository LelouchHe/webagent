// Share viewer — read-only public viewer for a session snapshot.
//
// Renders content events through the SAME `renderContentEvent` module the
// main app uses (public/js/render-event.ts), so the DOM produced here
// matches the main UI exactly — same class names, same structure, same
// styles.css selectors apply. The only differences are:
//
//  1. Image src: rewritten from `/api/v1/sessions/.../images/X` to
//     `/s/<token>/images/X` so unauthenticated viewers can fetch them.
//  2. Permission buttons: rendered (so the conversation looks complete)
//     but not wired to any onclick handler. Public viewers cannot act.
//  3. Code highlighting: lazy-loads the same hljs chunk as the main app.

import { renderContentEvent, isContentEventType } from "../render-event.ts";
import { enhanceCodeBlocks } from "../highlight.ts";
import type { StoredEvent } from "../../../src/types.ts";

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

function parseData(ev: StoredEvent): Record<string, unknown> {
  if (typeof ev.data === "string") {
    try {
      return JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return ev.data;
}

function makeImageRewriter(token: string): (src: string) => string {
  const re = /^\/api\/v1\/sessions\/[^/]+\/images\/([A-Za-z0-9._-]+)$/;
  return (src: string): string => {
    const m = re.exec(src);
    if (m) return `/s/${encodeURIComponent(token)}/images/${m[1]}`;
    return src;
  };
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function renderEvents(
  events: StoredEvent[],
  host: HTMLElement,
  token: string,
): void {
  // Pre-scan resolved permissions so permission_request renders without
  // buttons when a later permission_response settled it. Mirrors the main
  // app's replay path (events.ts: ReplayIndex.resolvedPermissions).
  const resolved = new Set<string>();
  for (const ev of events) {
    if (ev.type === "permission_response") {
      try {
        const p = JSON.parse(ev.data) as { requestId?: string };
        if (typeof p.requestId === "string") resolved.add(p.requestId);
      } catch {
        /* skip malformed */
      }
    }
  }

  // Per-stream lookup state: tracks tool-call / permission / bash elements
  // by id so update events can mutate the right element. Equivalent to the
  // main app's ReplayIndex but local to this viewer instance.
  const toolCalls = new Map<string, HTMLElement>();
  const permissions = new Map<string, HTMLElement>();
  let currentBashEl: HTMLElement | null = null;

  const hooks = {
    rewriteImageSrc: makeImageRewriter(token),
    enhanceMarkdown: enhanceCodeBlocks,
    findToolCallEl: (id: string) => toolCalls.get(id) ?? null,
    findPermissionEl: (reqId: string) => permissions.get(reqId) ?? null,
    findBashEl: () => currentBashEl,
    isPermissionResolved: (reqId: string) => resolved.has(reqId),
  };

  for (const ev of events) {
    if (!isContentEventType(ev.type)) continue;
    const d = parseData(ev);
    const el = renderContentEvent(ev.type, d, hooks);
    if (el) {
      host.appendChild(el);
      if (ev.type === "tool_call" && typeof d.id === "string") {
        toolCalls.set(d.id, el);
      } else if (
        ev.type === "permission_request" &&
        typeof d.requestId === "string"
      ) {
        permissions.set(d.requestId, el);
      } else if (ev.type === "bash_command") {
        currentBashEl = el;
      }
    } else if (ev.type === "bash_result") {
      currentBashEl = null;
    }
  }
}

async function main(): Promise<void> {
  // Set theme without an inline script (CSP: no unsafe-inline).
  try {
    const t = localStorage.getItem("theme") ?? "auto";
    document.documentElement.setAttribute("data-theme", t);
  } catch {
    /* ignore storage failures */
  }

  const m = /^\/s\/([A-Za-z0-9_-]{24})(?:[/?#]|$)/.exec(location.pathname);
  if (!m) {
    document.body.textContent = "invalid share URL";
    return;
  }
  const token = m[1];

  const infoEl = document.getElementById("session-info");
  const messagesEl = document.getElementById("messages");
  const footerMetaEl = document.querySelector(".share-footer-meta");
  if (!messagesEl) return;

  let payload: SharePayload;
  try {
    const res = await fetch(
      `/api/v1/shared/${encodeURIComponent(token)}/events`,
      {
        headers: { Accept: "application/json" },
        credentials: "omit",
      },
    );
    if (res.status === 410) {
      document.body.innerHTML = // xss-ok: static literal, no user input
        "<div class='share-gone'>此链接已撤销或过期。</div>";
      return;
    }
    if (!res.ok) {
      document.body.textContent = `error ${res.status}`;
      return;
    }
    payload = (await res.json()) as SharePayload;
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

  renderEvents(payload.events, messagesEl, token);

  if (footerMetaEl) {
    footerMetaEl.textContent = `snapshot #${payload.share.snapshot_seq} · ${formatTimestamp(payload.share.shared_at ?? payload.share.created_at)}`;
  }
}

void main();
