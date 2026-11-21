import { sanitizeHtml } from './richText';

/**
 * The signature added at the end of new messages and replies. Each account has its own, saved in this browser
 * (like the AI model choice), so the database does not change. Formatted text only, no images.
 */
const key = (account: string) => 'nexomail.signature:' + (account.toLowerCase() || 'sin-cuenta');
export const SIGNATURE_EVENT = 'nexomail:signature-changed';

export function loadSignature(account: string): string {
  try { return sanitizeHtml(localStorage.getItem(key(account)) ?? ''); } catch { return ''; }
}
export function saveSignature(account: string, html: string): void {
  const clean = sanitizeHtml(html).replace(/<img\b[^>]*>/gi, '');
  try { if (clean.replace(/<[^>]+>|&nbsp;|\s/g, '')) localStorage.setItem(key(account), clean); else localStorage.removeItem(key(account)); } catch { /* not saved */ }
  window.dispatchEvent(new CustomEvent(SIGNATURE_EVENT));
}

/** The block placed in a new message: an empty line to write on, then the signature, marked so it can be removed. */
export function withSignature(signature: string): string {
  return signature ? `<p><br></p><div data-signature="true">--<br>${signature}</div>` : '';
}
