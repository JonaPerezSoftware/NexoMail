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
export const MAX_ATTACHMENT_LABEL = OUTLOOK ? '3 MB' : '20 MB';
