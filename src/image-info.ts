// What an image container is, and how big its picture is.
//
// One reading of the bytes answers both questions: `image-size` owns the
// container parsing (PNG, JPEG, GIF, and all three WebP chunk layouts), and
// this module owns only the MIME vocabulary below. That split is deliberate —
// the library says "this is a webp", the table says "we store and serve webp".
//
// The vocabulary is a policy, not a parser: only the four containers this app
// both stores and serves inline have an entry. Every other format the library
// recognizes (bmp, tiff, heic, avif, svg, ...) maps to nothing, so a format
// gaining a parser upstream never gains admission here by accident.
//
// No `disableTypes()`: it mutates module-level state, which would hide this
// policy inside a side-effecting call and leak into every other caller.

import { imageSize } from "image-size";

export interface ImageInfo {
  mime: string;
  /** Pixel size, or null when the header does not carry a usable pair. */
  width: number | null;
  height: number | null;
}

const MIME_BY_TYPE: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Pixel dimensions as a reservable layout box, or null.
 *
 * A container can be storable and still not carry a usable size (a zero-sized
 * placeholder); an unusable pair is dropped, not rounded or guessed.
 */
function validPair(
  width: number,
  height: number,
): { width: number; height: number } | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Read an image's container and, when its header carries them, its dimensions.
 *
 * Returns null for anything that is not one of the four storable containers —
 * including formats the library parses happily (a BMP has dimensions too; it
 * is still not something this app serves inline).
 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  try {
    const size = imageSize(bytes);
    const type = size.type;
    const mime = type === undefined ? undefined : MIME_BY_TYPE[type];
    if (mime === undefined) return null;
    const dimensions = validPair(size.width, size.height);
    return {
      mime,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  } catch {
    // `image-size` identifies a container only once it can parse its header, so
    // a throw means "I cannot read this as the picture it claims to be". That
    // is the answer we want: the browser cannot decode such bytes either, and
    // storing them would only put a broken image in the transcript. The refusal
    // is visible — the caller writes `[image omitted: unrecognized image
    // format]` — never silent.
    //
    // This is a real tightening for all four containers: a PNG without its IHDR,
    // a JPEG without a SOF0/SOF1/SOF2 frame, and a GIF/WebP with a truncated
    // header are refused even though their signatures match. Signatures alone no
    // longer admit a file; the header has to be parseable too.
    return null;
  }
}
