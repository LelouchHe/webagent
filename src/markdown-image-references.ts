import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { attachmentDescriptor } from "./agent-image.ts";
import { reconstructLegacyCopilotImage } from "./agent-compatibility/copilot-image-path.ts";
import { parseImageAttachment } from "./shared/tool-content.ts";
import type { EventRow, Store } from "./store.ts";
import type {
  AgentImageAttachment,
  MarkdownImageReference,
  ToolContentItem,
} from "./types.ts";

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
  const titles = new Map<string, string>();
  const bindings = new Map<string, MarkdownImageReference>();
  for (const event of events) {
    const data = parseEventData(event);
    if (event.type === "tool_call" && typeof data.id === "string") {
      if (typeof data.title === "string") titles.set(data.id, data.title);
      continue;
    }
    if (event.type !== "tool_call_update" || typeof data.id !== "string")
      continue;
    let reference = explicitReference(
      store,
      taskId,
      data.recoveredCopilotImage,
    );
    if (!reference && Array.isArray(data.content)) {
      const content = data.content as ToolContentItem[];
      reference = reconstructLegacyCopilotImage({
        store,
        taskId,
        title:
          typeof data.title === "string"
            ? data.title
            : (titles.get(data.id) ?? ""),
        content,
      });
    }
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
  for (const event of events) {
    event.data = JSON.stringify(rewriteStrings(parseEventData(event), sorted));
  }
  return projected;
}
