/**
 * File viewer size limits.
 *
 * Kept as plain exported constants for now so the routes have a single,
 * testable knob; wiring these into `[limits]` config is a later milestone.
 * Values stay in the same order of magnitude as attachment limits and keep
 * the rendered/preview payloads bounded — the viewer never executes content,
 * but a 20 GB "text" file must not be read into memory either.
 */

/** Directory listings cap — beyond this the response is truncated + flagged. */
export const MAX_LIST_ITEMS = 2000;

/** Text (mime "text/plain") render cap — larger files are truncated + flagged. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024; // 4 MB

/** Image render cap — larger images are refused with 413 (no truncation). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Everything else (binaries): refuse above this with 413. */
export const MAX_OTHER_BYTES = 100 * 1024 * 1024; // 100 MB
