export interface ImageDimensions {
  width: number;
  height: number;
}

function valid(width: number, height: number): ImageDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  return (
    readPngDimensions(buf) ?? readGifDimensions(buf) ?? readJpegDimensions(buf)
  );
}

function readPngDimensions(buf: Buffer): ImageDimensions | null {
  // PNG: signature + IHDR width/height at fixed offsets.
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf.toString("ascii", 12, 16) === "IHDR"
  ) {
    return valid(buf.readUInt32BE(16), buf.readUInt32BE(20));
  }
  return null;
}

function readGifDimensions(buf: Buffer): ImageDimensions | null {
  // GIF87a/GIF89a: logical screen width/height, little-endian.
  if (
    buf.length >= 10 &&
    (buf.toString("ascii", 0, 6) === "GIF87a" ||
      buf.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return valid(buf.readUInt16LE(6), buf.readUInt16LE(8));
  }
  return null;
}

function isJpegSofMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readJpegDimensions(buf: Buffer): ImageDimensions | null {
  // JPEG: scan marker segments until a SOF marker carrying dimensions.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (offset < buf.length && buf[offset] === 0xff) offset++;
      const marker = buf[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 1 >= buf.length) break;
      const length = buf.readUInt16BE(offset);
      if (length < 2 || offset + length > buf.length) break;
      if (isJpegSofMarker(marker) && length >= 7) {
        return valid(
          buf.readUInt16BE(offset + 5),
          buf.readUInt16BE(offset + 3),
        );
      }
      offset += length;
    }
  }

  return null;
}
