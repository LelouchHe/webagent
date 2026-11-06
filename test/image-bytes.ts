// Image bytes for tests that push a picture through the real storage,
// event, and rendering paths.
//
// Every builder returns a header `image-size` can parse. A container with only
// its signature is refused by design (`src/image-info.ts`): the browser cannot
// decode such bytes either, so a fake signature no longer stands in for "an
// image" in these fixtures.
//
// `payloadBytes` is the exact total length: the header is padded (or the padding
// is dropped) to match, so a size ceiling and a content hash stay controllable
// without touching the pixel size.

/** PNG: signature + IHDR carrying the requested pixel size. */
export function png(payloadBytes = 64, width = 320, height = 240): Buffer {
  const head = Buffer.alloc(24);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  head.writeUInt32BE(13, 8); // IHDR chunk length
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return padTo(head, payloadBytes, 7);
}

/** GIF: logical screen descriptor carrying the requested pixel size. */
export function gif(payloadBytes = 64, width = 320, height = 240): Buffer {
  const head = Buffer.alloc(10);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return padTo(head, payloadBytes, 7);
}

/**
 * JPEG: SOI + APP0 + one frame header carrying the requested pixel size.
 *
 * `sof` selects the frame type: 0xc0 baseline, 0xc2 progressive (both readable),
 * 0xc3 lossless (deliberately unreadable — see `test/image-info.test.ts`).
 */
export function jpeg(
  payloadBytes = 64,
  width = 320,
  height = 240,
  sof = 0xc0,
): Buffer {
  const head = Buffer.from([
    0xff,
    0xd8,
    // APP0 segment, length 4 (2 payload bytes)
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    // Frame header, length 17. Precision=8, height, width.
    0xff,
    sof,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  return padTo(head, payloadBytes, 3);
}

/** WebP: RIFF/WEBP around a lossy `VP8 ` frame of the requested size. */
export function webp(payloadBytes = 64, width = 320, height = 240): Buffer {
  const head = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WEBPVP8 ", "latin1"),
    Buffer.from([0x0a, 0x00, 0x00, 0x00]),
  ]);
  const frame = Buffer.alloc(10);
  frame[0] = 0x30; // frame tag low byte
  frame[3] = 0x9d;
  frame[4] = 0x01;
  frame[5] = 0x2a;
  frame.writeUInt16LE(width, 6);
  frame.writeUInt16LE(height, 8);
  return padTo(Buffer.concat([head, frame]), payloadBytes, 1);
}

/** The header, padded with `fill` to `payloadBytes` (or left shorter). */
function padTo(header: Buffer, payloadBytes: number, fill: number): Buffer {
  if (payloadBytes <= header.length) return header;
  return Buffer.concat([
    header,
    Buffer.alloc(payloadBytes - header.length, fill),
  ]);
}
