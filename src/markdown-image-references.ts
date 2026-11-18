import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { attachmentDescriptor } from "./agent-image.ts";
import { parseImageAttachment } from "./shared/tool-content.ts";
import type { EventRow, Store } from "./store.ts";
import type { AgentImageAttachment, MarkdownImageReference } from "./types.ts";

function canonicalFileUri(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("file://")) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:" || url.host !== "" || url.search || url.hash) {
      return null;
    }
    const path = fileURLToPath(url);
    return path.startsWith("/") && url.href === raw ? url.href : null;
  } catch {
    return null;
  }
}

function validatedAttachment(
  store: Store,
  taskId: string,
  raw: unknown,
): AgentImageAttachment | null {
  const attachment = parseImageAttachment(raw);
  if (!attachment) return null;
  const row = store.getAttachment(taskId, attachment.attachmentId);
  if (row?.kind !== "image") return null;
  const expected = attachmentDescriptor(taskId, row);
  return expected.attachmentId === attachment.attachmentId &&
    expected.displayName === attachment.displayName &&
    expected.mimeType === attachment.mimeType &&
    expected.path === attachment.path &&
    (expected.width ?? null) === (attachment.width ?? null) &&
    (expected.height ?? null) === (attachment.height ?? null)
    ? attachment
    : null;
}

function explicitReference(
  store: Store,
  taskId: string,
  raw: unknown,
): MarkdownImageReference | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const sourceUri = canonicalFileUri(value.sourceUri);
  const attachment = validatedAttachment(store, taskId, value.attachment);
  return sourceUri && attachment ? { sourceUri, attachment } : null;
}

function parseEventData(event: EventRow): Record<string, unknown> {
  try {
    return JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Project verified, task-local Markdown image associations from persisted
 * events. First valid binding wins; malformed or conflicting late updates do
 * not retarget a source URI.
 */
export function projectMarkdownImageReferences(
  store: Store,
  taskId: string,
  events: EventRow[],
): MarkdownImageReference[] {
  const bindings = new Map<string, MarkdownImageReference>();
  for (const event of events) {
    const data = parseEventData(event);
    if (event.type !== "tool_call_update") continue;
    const reference = explicitReference(
      store,
      taskId,
      data.recoveredCopilotImage,
    );
    if (reference && !bindings.has(reference.sourceUri)) {
      bindings.set(reference.sourceUri, reference);
    }
  }
  return [...bindings.values()];
}

function rewriteStrings(
  value: unknown,
  replacements: Map<string, string>,
): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteStrings(item, replacements));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "recoveredCopilotImage") continue;
      out[key] = rewriteStrings(item, replacements);
    }
    return out;
  }
  return value;
}

function rewriteAcrossAssistantRun(
  texts: string[],
  replacements: Map<string, string>,
): string[] {
  const output = texts.map(() => "");
  const combined = texts.join("");
  const starts: number[] = [];
  let start = 0;
  for (const text of texts) {
    starts.push(start);
    start += text.length;
  }

  const ownerAt = (position: number): number => {
    let owner = starts.length - 1;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] > position) {
        owner = i - 1;
        break;
      }
    }
    return owner;
  };
  const appendRange = (from: number, to: number): void => {
    for (let i = 0; i < texts.length; i++) {
      const begin = Math.max(from, starts[i]);
      const end = Math.min(to, starts[i] + texts[i].length);
      if (begin < end) output[i] += combined.slice(begin, end);
    }
  };

  let cursor = 0;
  while (cursor < combined.length) {
    let nextIndex = -1;
    let nextFrom = "";
    let nextTo = "";
    for (const [from, to] of replacements) {
      const index = combined.indexOf(from, cursor);
      if (
        index >= 0 &&
        (nextIndex < 0 ||
          index < nextIndex ||
          (index === nextIndex && from.length > nextFrom.length))
      ) {
        nextIndex = index;
        nextFrom = from;
        nextTo = to;
      }
    }
    if (nextIndex < 0) {
      appendRange(cursor, combined.length);
      break;
    }
    appendRange(cursor, nextIndex);
    output[ownerAt(nextIndex)] += nextTo;
    cursor = nextIndex + nextFrom.length;
  }
  return output;
}

function rewriteAssistantRuns(
  events: EventRow[],
  replacements: Map<string, string>,
): void {
  for (let i = 0; i < events.length;) {
    if (events[i].type !== "assistant_message") {
      i++;
      continue;
    }
    const run: EventRow[] = [];
    const texts: string[] = [];
    while (
      i < events.length &&
      events[i].type === "assistant_message" &&
      (run.length === 0 || events[i].seq === run[run.length - 1].seq + 1)
    ) {
      const event = events[i];
      const data = parseEventData(event);
      run.push(event);
      texts.push(typeof data.text === "string" ? data.text : "");
      i++;
    }
    if (run.length === 0) {
      i++;
      continue;
    }
    const rewritten = rewriteAcrossAssistantRun(texts, replacements);
    for (let j = 0; j < run.length; j++) {
      const data = parseEventData(run[j]);
      data.text = rewritten[j];
      run[j].data = JSON.stringify(data);
    }
  }
}

/**
 * Build a share-local projection before redaction. Raw file identities are
 * replaced with opaque file-shaped tokens; public payloads expose neither an
 * owner attachment path nor the original local path.
 */
export function projectShareMarkdownImageReferences(
  token: string,
  references: MarkdownImageReference[],
  events: EventRow[],
): MarkdownImageReference[] {
  const projected = references.map((reference) => {
    const sourceUri = `file:///__webagent_share__/image-${reference.attachment.attachmentId}`;
    return {
      sourceUri,
      attachment: {
        ...reference.attachment,
        path: `/s/${encodeURIComponent(token)}/attachments/${basename(reference.attachment.path)}`,
      },
    };
  });
  const replacements = new Map<string, string>();
  for (let i = 0; i < references.length; i++) {
    const original = references[i].sourceUri;
    const safe = projected[i].sourceUri;
    replacements.set(original, safe);
    try {
      replacements.set(fileURLToPath(original), safe);
    } catch {
      // Projected references were canonicalized before this point.
    }
  }
  const sorted = new Map(
    [...replacements].sort(([a], [b]) => b.length - a.length),
  );
  rewriteAssistantRuns(events, sorted);
  for (const event of events) {
    event.data = JSON.stringify(rewriteStrings(parseEventData(event), sorted));
  }
  return projected;
}
