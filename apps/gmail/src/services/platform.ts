/** One interface for both mailboxes. The build sets VITE_PLATFORM; everything else follows from it. */
export type Platform = 'gmail' | 'outlook';
export const PLATFORM: Platform = import.meta.env.VITE_PLATFORM === 'outlook' ? 'outlook' : 'gmail';
const OUTLOOK = PLATFORM === 'outlook';
/** Name of the mailbox, as shown to the person. */
export const MAIL = OUTLOOK ? 'Outlook' : 'Gmail';
/** Company that authorizes the account. */
export const ACCOUNT = OUTLOOK ? 'Microsoft' : 'Google';
export const MAIL_API = OUTLOOK ? 'Microsoft Graph' : 'Gmail API';
/** Provider id used by the storage API. */
export const STORAGE_PROVIDER: 'gmail' | 'microsoft' = OUTLOOK ? 'microsoft' : 'gmail';
/** Graph accepts at most about 3 MB of inline attachments per message; Gmail's upload endpoint accepts far more. */
export const MAX_ATTACHMENT_BYTES = (OUTLOOK ? 3 : 20) * 1024 * 1024;
/** How many of the newest messages are loaded by default; the person can change it in Ajustes. */
export const INBOX_SCOPE = 50;
export const MAIL_COUNT_OPTIONS = [25, 50, 100] as const;
/** "Cargar más" adds this many each time, up to MAX_LOADED, so a request never grows without limit. */
export const LOAD_STEP = 25;
export const MAX_LOADED = 200;
const MAIL_COUNT_KEY = 'nexomail.mailCount';
export function savedMailCount(): number {
  try { const value = Number(localStorage.getItem(MAIL_COUNT_KEY)); return (MAIL_COUNT_OPTIONS as readonly number[]).includes(value) ? value : INBOX_SCOPE; } catch { return INBOX_SCOPE; }
}
export function saveMailCount(value: number): void {
  try { localStorage.setItem(MAIL_COUNT_KEY, String(value)); } catch { /* kept for this session only */ }
}
export const MAX_ATTACHMENT_LABEL = OUTLOOK ? '3 MB' : '20 MB';
