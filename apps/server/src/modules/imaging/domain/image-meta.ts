/** Image byte sniffing (pure): MIME type from magic bytes + width/height for PNG, JPEG, WebP, GIF. */

export interface ImageMeta {
  mimeType: string;
  width: number | null;
  height: number | null;
}

const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const be32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const le16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const le24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function sniffImage(b: Uint8Array): ImageMeta | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    return { mimeType: "image/png", width: be32(b, 16) || null, height: be32(b, 20) || null };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = be16(b, o + 2);
      if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
        return { mimeType: "image/jpeg", height: be16(b, o + 5) || null, width: be16(b, o + 7) || null };
      }
      o += 2 + len;
    }
    return { mimeType: "image/jpeg", width: null, height: null };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8X") return { mimeType: "image/webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
    if (kind === "VP8 ") return { mimeType: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mimeType: "image/webp", width: null, height: null };
  }
  if (b.length >= 10 && ascii(b, 0, 3) === "GIF") return { mimeType: "image/gif", width: le16(b, 6), height: le16(b, 8) };
  return null;
}
