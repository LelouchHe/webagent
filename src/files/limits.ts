/**
 * File viewer size limits.
 *
 * Kept as plain exported constants for now so the routes have a single,
 * testable knob; wiring these into `[limits]` config is a later milestone.
 * Values stay in the same order of magnitude as attachment limits and keep
 * rendered previews bounded. Files outside preview limits stream as downloads
 * instead of being buffered in server or browser memory.
 */

/** Directory listings cap — beyond this the response is truncated + flagged. */
export const MAX_LIST_ITEMS = 2000;

/** Text/Markdown/code preview + highlight cap; larger files download. */
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024; // 1 MiB

/** Image render cap — larger images stream as downloads. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
