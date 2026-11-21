import jsQR from 'jsqr';

/**
 * Reads a QR code from an image on this device (quishing: a QR that leads to a fake page, which filters
 * cannot follow because it is a picture). Nothing is sent anywhere; the address is only shown and checked.
 */
export async function readQr(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { return null; }
  try {
    // Large photos are scaled down: QR codes stay readable and it is much faster.
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height);
    const found = jsQR(data.data, width, height, { inversionAttempts: 'attemptBoth' });
    return found?.data?.trim() || null;
  } finally { bitmap.close(); }
}
