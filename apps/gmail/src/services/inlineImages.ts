import type { Email, MailAttachment } from '../types/email';
import { mailProvider } from './mailProvider';

/** Images inside the text are hidden from the attachment list, as Gmail and Outlook do. */
export function isInlineImage(attachment: MailAttachment, email: Email): boolean {
  if (!attachment.cid) return false;
  if (attachment.cid.startsWith('outlook-inline:')) return true;
  return (email.bodyHtml ?? '').includes('cid:' + attachment.cid);
}

const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, Record<string, string>>();

/**
 * The images a message shows inside its text (cid:), downloaded from the mailbox and turned into data: URLs, so the
 * protected reader can show them without loading anything from the internet. Only images, up to 8 MB in total.
 */
export async function loadInlineImages(email: Email, list: (email: Email) => Promise<MailAttachment[]>, download: (email: Email, attachment: MailAttachment) => Promise<Blob>): Promise<Record<string, string>> {
  if (!/\bcid:/i.test(email.bodyHtml ?? '')) return {};
  const key = mailProvider.getSessionKey() + ':' + email.id;
  const known = cache.get(key);
  if (known) return known;
  const images: Record<string, string> = {};
  let total = 0;
  for (const attachment of await list(email)) {
    if (!attachment.cid || !/^image\/(png|jpe?g|gif|webp)$/i.test(attachment.type)) continue;
    let cid = attachment.cid;
    if (cid.startsWith('outlook-inline:')) cid = (await mailProvider.inlineContentId?.(email, attachment).catch(() => '')) || '';
    if (!cid || !(email.bodyHtml ?? '').includes('cid:' + cid)) continue;
    if (total + attachment.size > MAX_INLINE_BYTES) break;
    try {
      const blob = await download(email, attachment);
      total += blob.size;
      images[cid] = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
    } catch { /* that image stays hidden; the rest of the message shows */ }
  }
  cache.set(key, images);
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  return images;
}
