import { PLATFORM } from './platform';
import { realGmailProvider } from './realGmailProvider';
import { outlookProvider } from './outlookProvider';
import type { Email, MailAttachment, MailFile } from '../types/email';

/** What a message carries besides To, subject and plain text: copies and the formatted version. */
export interface OutgoingExtra { cc?: string; bcc?: string; html?: string }

export { MAX_ATTACHMENT_BYTES } from './platform';

/** What the interface needs from a mailbox. Gmail and Outlook each implement it with their own API. */
export interface MailProvider {
  isConnected(): boolean;
  getSessionKey(): string;
  accountEmail(): string;
  restoreSession(): Promise<void>;
  /** Gmail can take a Client ID typed in the account dialog; Outlook uses the one in the options. */
  connect(clientId?: string): Promise<void>;
  disconnect(): Promise<void>;
  storageAccessToken(): Promise<string>;
  /** Gmail search syntax (in:inbox, in:sent, in:trash, is:starred, from:, to:, subject:, {a b} for OR). */
  fetchEmails(query?: string, maxResults?: number): Promise<Email[]>;
  trashEmails(ids: string[]): Promise<void>;
  untrashEmails(ids: string[]): Promise<void>;
  /** A cheap value that changes when new mail arrives (one tiny request), so the inbox is downloaded only then. */
  changeMarker(): Promise<string>;
  /** Moves messages out of spam into the inbox (the provider also learns they were not spam). */
  notSpamEmails(ids: string[]): Promise<void>;
  /** Reports messages as spam: they move to the spam/junk folder and the provider learns from it. */
  markSpamEmails(ids: string[]): Promise<void>;
  labelEmails(ids: string[], label: string): Promise<void>;
  removeLabel(ids: string[], label: string): Promise<void>;
  /** body is the plain-text copy; extra.html (sanitized) is sent as the formatted version, with inline images among the attachments. */
  sendEmail(recipient: string, subject: string, body: string, attachments?: MailFile[], extra?: OutgoingExtra): Promise<void>;
  markAsRead(id: string): Promise<void>;
  /** Attachments of a message (Outlook asks for them only when the message is opened). */
  listAttachments(email: Email): Promise<MailAttachment[]>;
  downloadAttachment(email: Email, attachment: MailAttachment): Promise<Blob>;
  /** Outlook only: the content id of an image inside the text, which its attachment list does not include. */
  inlineContentId?(email: Email, attachment: MailAttachment): Promise<string>;
}

export const mailProvider: MailProvider = PLATFORM === 'outlook' ? outlookProvider : realGmailProvider;
