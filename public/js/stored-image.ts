import type { AgentImageAttachment } from "../../src/types.ts";

export type StoredImageClass = "agent-image" | "tc-image";

export interface StoredImageProps {
  className: StoredImageClass;
  alt: string;
  src: string | null;
  loading: "lazy";
  width?: number;
  height?: number;
}

export interface StoredImageOptions {
  className: StoredImageClass;
  alt?: string;
  rewriteSrc?: (src: string) => string;
}

/**
 * Natural stored-image dimensions reserve layout without imposing CSS sizing.
 * Invalid or one-sided dimensions are deliberately omitted.
 */
export function naturalImageSize(
  rawWidth: unknown,
  rawHeight: unknown,
): { width: number; height: number } | null {
  if (typeof rawWidth !== "number" || typeof rawHeight !== "number") {
    return null;
  }
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) return null;
  if (rawWidth <= 0 || rawHeight <= 0) return null;
  return {
    width: Math.max(1, Math.round(rawWidth)),
    height: Math.max(1, Math.round(rawHeight)),
  };
}

export function storedImageProps(
  attachment: AgentImageAttachment | null,
  options: StoredImageOptions,
): StoredImageProps {
  const size = attachment
    ? naturalImageSize(attachment.width, attachment.height)
    : null;
  const src = attachment
    ? (options.rewriteSrc?.(attachment.path) ?? attachment.path)
    : null;
  return {
    className: options.className,
    alt: options.alt ?? attachment?.displayName ?? "",
    src,
    loading: "lazy",
    ...(size ?? {}),
  };
}

export function applyStoredImageProps(
  image: HTMLImageElement,
  props: StoredImageProps,
): HTMLImageElement {
  image.className = props.className;
  image.alt = props.alt;
  image.loading = props.loading;
  if (props.src) image.src = props.src;
  if (props.width !== undefined) image.width = props.width;
  if (props.height !== undefined) image.height = props.height;
  return image;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function serializeStoredImage(
  props: StoredImageProps,
  title?: string | null,
): string {
  const src = props.src ? ` src="${escapeAttribute(props.src)}"` : "";
  const size =
    props.width !== undefined && props.height !== undefined
      ? ` width="${props.width}" height="${props.height}"`
      : "";
  const titleAttribute =
    title != null ? ` title="${escapeAttribute(title)}"` : "";
  return `<img class="${props.className}" loading="lazy"${src} alt="${escapeAttribute(props.alt)}"${titleAttribute}${size}>`;
}
