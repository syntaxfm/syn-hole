import { MAX_POLL_IMAGE_BYTES, MAX_POLL_IMAGE_DIMENSION } from "~/utils/poll-images";

export { MAX_POLL_IMAGE_BYTES as MAX_SYNTAX_IMAGE_BYTES };
export const SYNTAX_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_SYNTAX_IMAGE_PIXELS = 16_000_000;

export class SyntaxImageError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const invalid = (): never => { throw new SyntaxImageError("Invalid, truncated or unsupported raster image."); };
function dimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_POLL_IMAGE_DIMENSION || height > MAX_POLL_IMAGE_DIMENSION || width * height > MAX_SYNTAX_IMAGE_PIXELS) {
    throw new SyntaxImageError(`Image dimensions must be 1–${MAX_POLL_IMAGE_DIMENSION}, with at most ${MAX_SYNTAX_IMAGE_PIXELS} pixels.`);
  }
  return { width, height };
}
function ascii(bytes: Uint8Array, start: number, count: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + count));
}
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

/** TIFF orientation changes the browser's intrinsic dimensions. Require normalized
 * screenshots rather than letting EXIF and raster dimensions disagree. */
function checkExif(bytes: Uint8Array): void {
  if (ascii(bytes, 0, 6) === "Exif\0\0") bytes = bytes.subarray(6);
  if (bytes.length < 8) invalid();
  const little = ascii(bytes, 0, 2) === "II";
  if (!little && ascii(bytes, 0, 2) !== "MM") invalid();
  const data = view(bytes);
  if (data.getUint16(2, little) !== 42) invalid();
  const offset = data.getUint32(4, little);
  if (offset < 8 || offset + 2 > bytes.length) invalid();
  const count = data.getUint16(offset, little);
  if (offset + 2 + count * 12 + 4 > bytes.length) invalid();
  for (let i = 0; i < count; i++) {
    const pos = offset + 2 + i * 12;
    if (data.getUint16(pos, little) !== 0x112) continue;
    if (data.getUint16(pos + 2, little) !== 3 || data.getUint32(pos + 4, little) !== 1 || data.getUint16(pos + 8, little) !== 1) {
      throw new SyntaxImageError("Normalize image orientation before uploading (EXIF orientation must be 1).");
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let n = index;
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc(bytes: Uint8Array): number {
  let n = 0xffffffff;
  for (const byte of bytes) n = (n >>> 8) ^ crcTable[(n ^ byte) & 255];
  return (n ^ 0xffffffff) >>> 0;
}

async function png(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  if (ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n") invalid();
  const data = view(bytes);
  let width = 0, height = 0, depth = 0, color = -1, interlace = 0;
  let ended = false, palette = false, dataEnded = false;
  const compressed: Uint8Array[] = [];
  for (let pos = 8; pos < bytes.length;) {
    if (pos + 12 > bytes.length) invalid();
    const length = data.getUint32(pos);
    const end = pos + length + 12;
    if (end > bytes.length) invalid();
    const kind = ascii(bytes, pos + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(kind) || crc(bytes.subarray(pos + 4, end - 4)) !== data.getUint32(end - 4)) invalid();
    const content = bytes.subarray(pos + 8, end - 4);
    if (pos === 8 && kind !== "IHDR") invalid();
    if (kind === "IHDR") {
      if (pos !== 8 || length !== 13) invalid();
      width = data.getUint32(pos + 8); height = data.getUint32(pos + 12);
      dimensions(width, height);
      depth = content[8]; color = content[9]; interlace = content[12];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || content[10] !== 0 || content[11] !== 0 || interlace > 1) invalid();
    } else if (kind === "PLTE") {
      if (palette || compressed.length || !length || length % 3 || length > 768 || color === 0 || color === 4 || (color === 3 && length / 3 > 2 ** depth)) invalid();
      palette = true;
    } else if (kind === "IDAT") {
      if (dataEnded || (color === 3 && !palette)) invalid();
      compressed.push(content);
    } else {
      if (compressed.length) dataEnded = true;
      if (kind === "IEND") {
        if (length !== 0 || end !== bytes.length || !compressed.length) invalid();
        ended = true;
      } else if (kind === "eXIf") checkExif(content);
      else if (kind === "acTL") throw new SyntaxImageError("Use a still screenshot, not an animated image.");
      else if (kind[0] === kind[0].toUpperCase()) invalid();
    }
    pos = end;
  }
  if (!ended) invalid();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const rows: { bytes: number; count: number }[] = [];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) rows.push({ bytes: Math.ceil(w * channels * depth / 8) + 1, count: h });
  }
  const expected = rows.reduce((sum, row) => sum + row.bytes * row.count, 0);
  if (expected > 64 * 1024 * 1024) throw new SyntaxImageError("Decoded image is larger than 64 MB.");
  // Streaming decompression: bound output using the decoded dimensions, never
  // allocate a decompression-bomb-sized bitmap or trust a declared body length.
  const stream = new ReadableStream<BufferSource>({ start(controller) { for (const part of compressed) controller.enqueue(new Uint8Array(part).buffer); controller.close(); } });
  const reader = stream.pipeThrough(new DecompressionStream("deflate")).getReader();
  let total = 0, pass = 0, rowOffset = 0, rowCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > expected) invalid();
      for (const byte of value) {
        if (rowOffset === 0 && byte > 4) invalid();
        rowOffset++;
        if (rowOffset === rows[pass].bytes) {
          rowOffset = 0;
          if (++rowCount === rows[pass].count) { pass++; rowCount = 0; }
        }
      }
      total += value.length;
    }
    if (total !== expected) invalid();
  } catch { invalid(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { width, height };
}

function jpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  const data = view(bytes);
  let result: { width: number; height: number } | undefined;
  let scan = false, quantization = false, huffman = false;
  for (let pos = 2; pos < bytes.length;) {
    if (bytes[pos++] !== 0xff) invalid();
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0xd9) { if (pos !== bytes.length || !scan || !quantization || !huffman) invalid(); return result ?? invalid(); }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || pos + 2 > bytes.length) invalid();
    const length = data.getUint16(pos);
    if (length < 2 || pos + length > bytes.length) invalid();
    const body = bytes.subarray(pos + 2, pos + length);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (result || body.length < 6 || body[0] !== 8 || ![1, 3, 4].includes(body[5]) || length !== 8 + 3 * body[5]) invalid();
      result = dimensions(data.getUint16(pos + 5), data.getUint16(pos + 3));
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid();
    else if (marker === 0xdb) { if (body.length < 65) invalid(); quantization = true; }
    else if (marker === 0xc4) { if (body.length < 18) invalid(); huffman = true; }
    else if (marker === 0xe1 && ascii(body, 0, 6) === "Exif\0\0") checkExif(body);
    pos += length;
    if (marker === 0xda) {
      if (!result || body.length < 6 || body[0] < 1 || body[0] > 4 || length !== 6 + 2 * body[0]) invalid();
      const start = pos;
      while (pos < bytes.length) {
        if (bytes[pos] !== 0xff) { pos++; continue; }
        const next = bytes[pos + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { pos += 2; continue; }
        break;
      }
      if (pos === start) invalid();
      scan = true;
    }
  }
  return invalid();
}

function gif(bytes: Uint8Array): { width: number; height: number } {
  if (!["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)) || bytes.length < 14) invalid();
  const data = view(bytes);
  const result = dimensions(data.getUint16(6, true), data.getUint16(8, true));
  let pos = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), frames = 0;
  const blocks = () => {
    let length = 0;
    while (pos < bytes.length) {
      const count = bytes[pos++];
      if (!count) return length;
      pos += count; length += count;
      if (pos > bytes.length) invalid();
    }
    return invalid();
  };
  while (pos < bytes.length) {
    const marker = bytes[pos++];
    if (marker === 0x3b) { if (frames !== 1 || pos !== bytes.length) invalid(); return result; }
    if (marker === 0x21) { if (pos >= bytes.length) invalid(); pos++; blocks(); }
    else if (marker === 0x2c) {
      if (pos + 9 > bytes.length || ++frames > 1) invalid();
      const left = data.getUint16(pos, true), top = data.getUint16(pos + 2, true);
      const frame = dimensions(data.getUint16(pos + 4, true), data.getUint16(pos + 6, true));
      if (left + frame.width > result.width || top + frame.height > result.height) invalid();
      const flags = bytes[pos + 8];
      if (!(flags & 128) && !(bytes[10] & 128)) invalid();
      pos += 9 + ((flags & 128) ? 3 * (2 ** ((flags & 7) + 1)) : 0);
      if (pos >= bytes.length || bytes[pos] < 2 || bytes[pos++] > 8 || !blocks()) invalid();
    } else invalid();
  }
  return invalid();
}

function webp(bytes: Uint8Array): { width: number; height: number } {
  const data = view(bytes);
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP" || data.getUint32(4, true) + 8 !== bytes.length) invalid();
  let canvas: { width: number; height: number } | undefined, raster: { width: number; height: number } | undefined;
  for (let pos = 12; pos < bytes.length;) {
    if (pos + 8 > bytes.length) invalid();
    const kind = ascii(bytes, pos, 4), size = data.getUint32(pos + 4, true), start = pos + 8;
    if (start + size + (size & 1) > bytes.length) invalid();
    if (kind === "VP8X") {
      if (pos !== 12 || size !== 10 || (bytes[start] & 0xc3) || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) invalid();
      const w = bytes[start + 4] | (bytes[start + 5] << 8) | (bytes[start + 6] << 16);
      const h = bytes[start + 7] | (bytes[start + 8] << 8) | (bytes[start + 9] << 16);
      canvas = dimensions(w + 1, h + 1);
    } else if (kind === "VP8 ") {
      if (raster || size < 11 || (bytes[start] & 1) || ascii(bytes, start + 3, 3) !== "\x9d\x01\x2a") invalid();
      const partition = (bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16)) >>> 5;
      if (!partition || partition + 10 > size) invalid();
      raster = dimensions(data.getUint16(start + 6, true) & 0x3fff, data.getUint16(start + 8, true) & 0x3fff);
    } else if (kind === "VP8L") {
      if (raster || size < 6 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0)) invalid();
      const bits = data.getUint32(start + 1, true);
      raster = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (kind === "ANIM" || kind === "ANMF") invalid();
    else if (kind === "EXIF") checkExif(bytes.subarray(start, start + size));
    else if (!["ALPH", "ICCP", "XMP "].includes(kind)) invalid();
    pos = start + size + (size & 1);
  }
  if (!raster || (canvas && (canvas.width !== raster.width || canvas.height !== raster.height))) invalid();
  return raster ?? invalid();
}

/** Decode dimensions from the raster bytes, not x-image-* or Content-Type.
 * Validate container boundaries/termination; PNG also checks CRCs and decoded
 * scanline lengths. JPEG/GIF/WebP entropy decoding stays with the browser.
 * AVIF and animated images are deliberately rejected: no reliable AV1 decoder
 * is available in this Worker, and screenshots do not require animation. */
export async function inspectSyntaxImage(bytes: Uint8Array, declaredType: string): Promise<{ width: number; height: number; contentType: string }> {
  if (!(SYNTAX_IMAGE_TYPES as readonly string[]).includes(declaredType)) throw new SyntaxImageError("Use a still PNG, JPEG, GIF or WebP screenshot (SVG and AVIF are not supported).", 415);
  let contentType: string;
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") contentType = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) contentType = "image/jpeg";
  else if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) contentType = "image/gif";
  else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") contentType = "image/webp";
  else return invalid();
  if (contentType !== declaredType) throw new SyntaxImageError("Content-Type does not match the image bytes.", 415);
  const size = contentType === "image/png" ? await png(bytes) : contentType === "image/jpeg" ? jpeg(bytes) : contentType === "image/gif" ? gif(bytes) : webp(bytes);
  return { ...size, contentType };
}
