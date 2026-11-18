import { parseImageAttachment } from "../../src/shared/tool-content.ts";
import type { MarkdownImageReference } from "../../src/types.ts";

let scope: string | null = null;
const bindings = new Map<string, MarkdownImageReference>();
const listeners = new Set<(changed: string[]) => void>();

function validReference(raw: unknown): MarkdownImageReference | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.sourceUri !== "string") return null;
  try {
    const url = new URL(value.sourceUri);
    if (
      url.protocol !== "file:" ||
      url.host !== "" ||
      url.search ||
      url.hash ||
      url.href !== value.sourceUri
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const attachment = parseImageAttachment(value.attachment);
  return attachment ? { sourceUri: value.sourceUri, attachment } : null;
}

export function setMarkdownImageReferenceScope(
  nextScope: string,
  references: unknown,
): void {
  if (scope !== nextScope) {
    scope = nextScope;
    bindings.clear();
  }
  registerMarkdownImageReferences(references);
}

export function registerMarkdownImageReferences(references: unknown): void {
  if (!Array.isArray(references)) return;
  const changed: string[] = [];
  for (const raw of references) {
    const reference = validReference(raw);
    if (!reference) continue;
    const existing = bindings.get(reference.sourceUri);
    if (existing) {
      if (!sameAttachmentIdentity(existing, reference)) continue;
      if (existing.attachment.path === reference.attachment.path) continue;
      bindings.set(reference.sourceUri, reference);
      changed.push(reference.sourceUri);
      continue;
    }
    bindings.set(reference.sourceUri, reference);
    changed.push(reference.sourceUri);
  }
  if (changed.length === 0) return;
  for (const listener of listeners) listener(changed);
}

function sameAttachmentIdentity(
  left: MarkdownImageReference,
  right: MarkdownImageReference,
): boolean {
  const a = left.attachment;
  const b = right.attachment;
  return (
    a.attachmentId === b.attachmentId &&
    a.displayName === b.displayName &&
    a.mimeType === b.mimeType &&
    a.path.split("?")[0] === b.path.split("?")[0] &&
    (a.width ?? null) === (b.width ?? null) &&
    (a.height ?? null) === (b.height ?? null)
  );
}

export function registerMarkdownImageReference(reference: unknown): void {
  registerMarkdownImageReferences([reference]);
}

export function resolveMarkdownImageReference(
  sourceUri: string,
): MarkdownImageReference | null {
  return bindings.get(sourceUri) ?? null;
}

export function onMarkdownImageReferenceChange(
  listener: (changed: string[]) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearMarkdownImageReferenceScope(): void {
  scope = null;
  bindings.clear();
}
