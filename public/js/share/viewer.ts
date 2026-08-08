// Share viewer — read-only public viewer for a session snapshot.
//
// Renders content events through the SAME `renderContentEvent` module the
// main app uses (public/js/render-event.ts), so the DOM produced here
// matches the main UI exactly — same class names, same structure, same
// styles.css selectors apply. The only differences are:
//
//  1. Image src: rewritten from `/api/v1/sessions/.../attachments/X` to
//     `/s/<token>/attachments/X` so unauthenticated viewers can fetch them.
//  2. Permission buttons: rendered (so the conversation looks complete)
//     but not wired to any onclick handler. Public viewers cannot act.
//  3. Code highlighting: lazy-loads the same hljs chunk as the main app.

import {
  renderContentEvent,
  isContentEventType,
  updateAssistantDisplay,
} from "../render-event.ts";
import { extractCompletedFinalAnswer } from "../event-interpreter.ts";
import { enhanceCodeBlocks } from "../highlight.ts";
import { formatRelativeTime, formatExactUtc } from "../relative-time.ts";
import { makeAttachmentRewriter } from "./attachment-rewriter.ts";
import "../lightbox.ts"; // click-to-enlarge user-image, same as main app
import "../theme.ts"; // wires #theme-btn click + applies saved theme
import type { StoredEvent } from "../../../src/types.ts";
import type { ToolContentItem } from "../../../src/types.ts";
import { HTTP_STATUS } from "../../../src/http-status.ts";

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

function mergeAdjacentAssistant(
  event: StoredEvent,
  previous: StoredEvent | null,
  previousEl: HTMLElement | null,
  data: Record<string, unknown>,
): boolean {
  if (
    event.type !== "assistant_message" ||
    previous?.type !== "assistant_message" ||
    event.seq !== previous.seq + 1 ||
    !previousEl?.classList.contains("assistant")
  ) {
    return false;
  }
  const combined =
    (previousEl.getAttribute("data-raw") ?? "") +
    (typeof data.text === "string" ? data.text : "");
  previousEl.setAttribute("data-raw", combined);
  updateAssistantDisplay(previousEl, combined, undefined, true);
  enhanceCodeBlocks(previousEl);
  return true;
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
  let finalAnswerToolText: string | null = null;

  const hooks = {
    rewriteAttachmentSrc: makeAttachmentRewriter(token),
    enhanceMarkdown: enhanceCodeBlocks,
    findToolCallEl: (id: string) => toolCalls.get(id) ?? null,
    findPermissionEl: (reqId: string) => permissions.get(reqId) ?? null,
    findBashEl: () => currentBashEl,
    isPermissionResolved: (reqId: string) => resolved.has(reqId),
    finalAnswerToolText: null as string | null,
  };

  for (let index = 0; index < events.length; index++) {
    const ev = events[index];
    if (!isContentEventType(ev.type)) continue;
    const d = parseData(ev);
    const previous = index > 0 ? events[index - 1] : null;
    const previousEl = host.lastElementChild as HTMLElement | null;
    if (mergeAdjacentAssistant(ev, previous, previousEl, d)) {
      finalAnswerToolText = null;
      continue;
    }
    hooks.finalAnswerToolText =
      ev.type === "assistant_message" ? finalAnswerToolText : null;
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

    if (ev.type === "tool_call_update") {
      finalAnswerToolText = extractCompletedFinalAnswer(
        typeof d.status === "string" ? d.status : "",
        Array.isArray(d.content) ? (d.content as ToolContentItem[]) : undefined,
      );
    } else {
      finalAnswerToolText = null;
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
  const footerAuthorEl = document.querySelector(".share-footer-author");
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
    if (res.status === HTTP_STATUS.GONE) {
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
    // Header shows ONLY the title (already truncated on mobile).
    // The author attribution moved to the footer where it
    // gets its own line on narrow screens via flex-wrap. The header
    // [shared] badge already conveys "this is a shared snapshot",
    // so the footer line is just `by <name>` (no repeated "shared").
    infoEl.textContent = payload.share.session_title ?? "(untitled)";
  }

  if (footerAuthorEl) {
    const name = payload.share.display_name ?? "";
    // Empty textContent is fine: CSS `.share-footer-author:empty {
    // display: none }` removes it from layout, and the ::after-bullet
    // rule's `:not(:empty)` predicate suppresses the separator in turn.
    footerAuthorEl.textContent = name ? `by ${name}` : "";
  }

  renderEvents(payload.events, messagesEl, token);

  if (footerMetaEl) {
    const iso = payload.share.shared_at ?? payload.share.created_at;
    footerMetaEl.textContent = formatRelativeTime(iso, new Date());
    // Hover tooltip shows the precise UTC timestamp for readers who want
    // exact provenance — keeps the visible label short while preserving
    // the discoverable detail.
    if (footerMetaEl instanceof HTMLElement) {
      footerMetaEl.title = formatExactUtc(iso);
    }
  }
}

void main();
