import type { Email } from '../types/email';
import { normalizeText } from './mailIntent';

/**
 * The people this account writes to, remembered after their messages leave the 50 newest.
 * Learned from the sent folder, from sends approved in NexoMail and from people who write to you.
 * Kept only in this browser (localStorage), per account: addresses, names and counts, never content.
 */
export interface Contact { address: string; name?: string; sent: number; received: number; last: number }
/** Stored form: message ids (capped) instead of counters, so seeing a message again never counts it twice. */
interface Stored { address: string; name?: string; sentIds: string[]; receivedIds: string[]; last: number }
interface Book { v: 2; contacts: Record<string, Stored>; backfilled?: boolean; scannedAt?: number }
const MAX_IDS = 30;
const view = (s: Stored): Contact => ({ address: s.address, name: s.name, sent: s.sentIds.length, received: s.receivedIds.length, last: s.last });

const MAX_CONTACTS = 2000;
/** Notifications and mailing systems are not people you would write to. */
const AUTOMATED = /(?:^|[._+-])(?:no-?reply|do-?not-?reply|notifica\w*|notifications?|alerts?|mailer-daemon|postmaster|bounce\w*|news(?:letter)?|marketing|info|soporte-automatico)(?:[._+-]|@)/i;
const ADDRESS = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

const key = (session: string) => 'nexomail.contacts.' + session.replace(/[^\w:.-]/g, '_').slice(0, 120);
const memory = new Map<string, Book>();

function load(session: string): Book {
  const cached = memory.get(session);
  if (cached) return cached;
  let book: Book = { v: 2, contacts: {} };
  try { const raw = localStorage.getItem(key(session)); if (raw) { const parsed = JSON.parse(raw); if (parsed?.v === 2 && parsed.contacts) book = parsed; } } catch { /* start empty */ }
  memory.set(session, book);
  return book;
}
function save(session: string, book: Book) {
  const entries = Object.values(book.contacts);
  if (entries.length > MAX_CONTACTS) {
    entries.sort((a, b) => b.sentIds.length - a.sentIds.length || b.last - a.last);
    book.contacts = Object.fromEntries(entries.slice(0, MAX_CONTACTS).map(c => [c.address, c]));
  }
  try { localStorage.setItem(key(session), JSON.stringify(book)); } catch { /* storage full or blocked: keep it in memory */ }
}

/** "Ana Gómez <ana@x.com>, bob@y.com" → [{address, name}]. */
export function parseAddressList(list: string): { address: string; name?: string }[] {
  const out: { address: string; name?: string }[] = [];
  for (const part of list.split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const angle = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const address = (angle ? angle[2] : part).trim().toLowerCase();
    if (!ADDRESS.test(address)) continue;
    const name = angle?.[1]?.trim();
    out.push({ address, ...(name && name.toLowerCase() !== address ? { name } : {}) });
  }
  return out;
}

function note(book: Book, address: string, name: string | undefined, kind: 'sent' | 'received', when: number, messageId: string) {
  const contact = book.contacts[address] ?? (book.contacts[address] = { address, sentIds: [], receivedIds: [], last: 0 });
  if (name && (!contact.name || kind === 'sent')) contact.name = name;
  const ids = kind === 'sent' ? contact.sentIds : contact.receivedIds;
  if (!ids.includes(messageId)) { ids.push(messageId); if (ids.length > MAX_IDS) ids.shift(); }
  contact.last = Math.max(contact.last, when || 0);
}

/** Learns from loaded messages: recipients of sent ones, people who wrote to you in the others. */
export function learnContacts(session: string, emails: Email[], self = ''): void {
  if (!session || !emails.length) return;
  const book = load(session);
  const me = self.toLowerCase();
  for (const email of emails) {
    if (email.labels.includes('SENT')) {
      for (const r of parseAddressList(email.recipient)) if (r.address !== me) note(book, r.address, r.name, 'sent', email.timestamp, email.id);
    } else {
      const address = email.sender.toLowerCase();
      if (ADDRESS.test(address) && address !== me && !AUTOMATED.test(address)) note(book, address, email.senderName !== email.sender ? email.senderName : undefined, 'received', email.timestamp, email.id);
    }
  }
  save(session, book);
}

/** A message NexoMail just sent (after your approval). */
export function recordSent(session: string, recipients: string): void {
  const book = load(session);
  const now = Date.now();
  for (const r of parseAddressList(recipients)) note(book, r.address, r.name, 'sent', now, 'nexomail-' + now);
  save(session, book);
}

/** The first time, read a long stretch of the sent folder; then a short one once a day. */
export function sentScanSize(session: string): number {
  const book = load(session);
  if (!book.backfilled) return 200;
  return Date.now() - (book.scannedAt ?? 0) > 24 * 3600 * 1000 ? 50 : 0;
}
export function markSentScanned(session: string): void {
  const book = load(session);
  book.backfilled = true; book.scannedAt = Date.now();
  save(session, book);
}

/** Titles and filler around a name: «la profesora Almeida» → almeida. */
const FILLER = new Set(['los','las','del','mis','profesora','profesor','ingeniero','ingeniera','ing','senor','senora','sres','sra','don','dona','doctor','doctora','licenciado','licenciada','lic','amigo','amiga','jefe','jefa','companero','companera','correo','email']);
const words = (value: string) => normalizeText(value).split(/[^a-z0-9ñ]+/).filter(Boolean);

/**
 * Contacts matching a name or part of an address ("almeida" → aalmeidac7@unemi.edu.ec).
 * People you have written to come first, then people who wrote to you.
 */
export function findContacts(session: string, query: string, limit = 5): Contact[] {
  const terms = words(query).filter(t => t.length >= 3 && !FILLER.has(t));
  if (!terms.length) return [];
  const scored: { c: Contact; score: number }[] = [];
  for (const c of Object.values(load(session).contacts).map(view)) {
    const local = normalizeText(c.address.split('@')[0]);
    // Parts of the address count as name words too: ana.lopez@… answers to «ana» and «lopez».
    const nameWords = [...words(c.name ?? ''), ...words(local.replace(/[0-9]+/g, ' '))];
    let score = 0;
    for (const t of terms) {
      if (normalizeText(c.address) === t) score += 10;
      else if (nameWords.includes(t)) score += 4;
      else if (t.length >= 4 && (local.includes(t) || nameWords.some(w => w.startsWith(t)))) score += 3;
      else { score = -1; break; }
    }
    if (score > 0) scored.push({ c, score: score + Math.min(c.sent, 5) + (c.sent ? 3 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || b.c.last - a.c.last).slice(0, limit).map(s => s.c);
}

/** Contacts whose name or address matches any word of the request: given to the AI so it uses the real address. */
export function contactsMentioned(session: string, prompt: string, limit = 8): Contact[] {
  const found = new Map<string, Contact>();
  for (const word of words(prompt).filter(w => w.length >= 4)) {
    for (const c of findContacts(session, word, 3)) found.set(c.address, c);
  }
  return [...found.values()].sort((a, b) => b.sent - a.sent || b.last - a.last).slice(0, limit);
}

export const describeContact = (c: Contact) => `${c.name ? `${c.name} <${c.address}>` : c.address}${c.sent ? ` (le escribiste ${c.sent} ${c.sent === 1 ? 'vez' : 'veces'})` : ' (te escribió)'}`;
