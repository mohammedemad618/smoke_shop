// The receipt's logo: a small PNG, JPEG or WebP image kept in the shop's settings as a
// data: URL, which the shop's Content-Security-Policy allows for images (lib/security.js)
// and which needs no file on disk. The settings page shrinks the picture in the browser to
// fit LOGO_SIDE pixels; the server takes it only if it is really an image of the type it
// says, at most LOGO_MAX_BYTES and LOGO_SIDE x LOGO_SIDE, read from the image's own header.
// No side effects on import.

export const LOGO_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const LOGO_MAX_BYTES = 64 * 1024;
// A thermal printer's dots across a 58 mm roll (48 mm printed), and the most a logo needs
export const LOGO_SIDE = 384;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
// What the data: URL of LOGO_MAX_BYTES takes, with its header
const MAX_LENGTH = 'data:image/jpeg;base64,'.length + Math.ceil(LOGO_MAX_BYTES / 3) * 4;

const ascii = (buf, at, length) => buf.toString('latin1', at, at + length);

// A PNG: the signature, then the IHDR chunk with the width and height
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (ascii(buf, 12, 4) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// A JPEG: the start marker, then segments up to the frame header (SOFn) that holds the size
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1];
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    // Markers without a length: TEM, RSTn, SOI, EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null; // the end, and no frame header
      at += 2;
      continue;
    }
    const length = buf.readUInt16BE(at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

// A WebP: RIFF....WEBP, then a lossy (VP8 ), lossless (VP8L) or extended (VP8X) chunk
function webpSize(buf) {
  if (buf.length < 30 || ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WEBP') return null;
  if (buf.readUInt32LE(4) + 8 !== buf.length) return null;
  const chunk = ascii(buf, 12, 4);
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

const SIZE_OF = { 'image/png': pngSize, 'image/jpeg': jpegSize, 'image/webp': webpSize };

// What is wrong with a logo (an Arabic sentence for the owner), or null when it can be kept
export function logoProblem(value) {
  if (typeof value !== 'string') return 'صورة الشعار غير صالحة';
  if (value.length > MAX_LENGTH) return 'صورة الشعار كبيرة جدًا. الحد 64 كيلوبايت';
  const match = DATA_URL.exec(value);
  if (!match || match[2].length % 4 !== 0) return 'الشعار يجب أن يكون صورة PNG أو JPEG أو WebP';
  const [, type, base64] = match;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > LOGO_MAX_BYTES) return 'صورة الشعار كبيرة جدًا. الحد 64 كيلوبايت';
  let size = null;
  try {
    size = SIZE_OF[type](bytes);
  } catch {
    // a header cut short: read past the end
  }
  if (!size || !(size.width > 0) || !(size.height > 0)) return 'ملف الشعار ليس صورة صالحة من النوع الذي يذكره';
  if (size.width > LOGO_SIDE || size.height > LOGO_SIDE) return `أبعاد الشعار يجب ألا تزيد على ${LOGO_SIDE} × ${LOGO_SIDE} نقطة`;
  return null;
}
