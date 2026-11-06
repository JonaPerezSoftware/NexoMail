import { PLATFORM } from './platform';
import { realGmailProvider } from './realGmailProvider';
import { outlookProvider } from './outlookProvider';
import type { Email, MailAttachment, MailFile } from '../types/email';

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
  labelEmails(ids: string[], label: string): Promise<void>;
  removeLabel(ids: string[], label: string): Promise<void>;
  sendEmail(recipient: string, subject: string, body: string, attachments?: MailFile[]): Promise<void>;
  markAsRead(id: string): Promise<void>;
  /** Attachments of a message (Outlook asks for them only when the message is opened). */
  listAttachments(email: Email): Promise<MailAttachment[]>;
  downloadAttachment(email: Email, attachment: MailAttachment): Promise<Blob>;
}

export const mailProvider: MailProvider = PLATFORM === 'outlook' ? outlookProvider : realGmailProvider;
