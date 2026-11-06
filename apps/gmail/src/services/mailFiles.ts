import type { MailFile } from '../types/email';

/** Photos larger than this are reduced before attaching; smaller files are sent as they are. */
const REDUCE_ABOVE_BYTES = 1024 * 1024;
/** Longest side after reducing: plenty to view a photo in an email. */
const MAX_SIDE = 2000;
const JPEG_QUALITY = 0.85;
/** Only formats the browser can decode. HEIC, GIF (may be animated) and everything else is kept intact. */
const REDUCIBLE = /^image\/(?:jpeg|png|webp)$/;

export const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

/** Re-encodes a large photo as JPEG of at most MAX_SIDE pixels. Returns null if it would not be smaller. */
async function reducePhoto(file: File): Promise<Blob | null> {
  if (!REDUCIBLE.test(file.type) || file.size <= REDUCE_ABOVE_BYTES || typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    // JPEG has no transparency: transparent areas of a PNG become white, not black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return blob && blob.size < file.size * 0.9 ? blob : null;
  } finally {
    bitmap.close();
  }
}

/**
 * Reads a file to attach. Large photos are reduced first so the message uploads much faster;
 * originalSize records the size before, to tell the person.
 */
export async function readMailFile(file: File): Promise<MailFile> {
  try {
    const reduced = await reducePhoto(file);
    if (reduced) {
      const name = file.name.replace(/\.(?:png|webp|jpe?g)$/i, '') + '.jpg';
      return { name, type: 'image/jpeg', size: reduced.size, data: await toBase64(reduced), originalSize: file.size };
    }
    return { name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: await toBase64(file) };
  } catch {
    throw new Error(file.name);
  }
}

/** Turns base64 or base64url text (as Gmail and Outlook send attachments) into a file in memory. */
export function base64ToBlob(data: string, type: string): Blob {
  const clean = data.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}
