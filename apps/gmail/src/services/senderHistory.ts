import { addFinding, downgradeMismatches, LINK_MISMATCH, MISMATCH_WITH_DECEIT } from '@shared/mail/mail-insights';
import { findLookalike, registrableDomain } from '@shared/mail/sender-intel';
import type { Email } from '../types/email';

/**
 * Who usually writes to this account, kept only in this browser (localStorage), per account.
 * It lets NexoMail notice what Gmail and Outlook do not compare against *your* mailbox:
 * a domain that imitates one you deal with, the first message from someone new,
 * and a stranger joining one of your conversations.
 * Only domains, addresses and message ids are stored: never subjects or content.
 */
interface Stat { ids: string[]; first: number; contact?: boolean; verified?: boolean }
interface History { v: 1; domains: Record<string, Stat>; addresses: Record<string, Stat>; messages: number; sentScan?: number }

/** Domains shared by millions of people: knowing one person there says nothing about the next one. */
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.es', 'outlook.com', 'outlook.es', 'live.com', 'live.com.mx', 'msn.com', 'yahoo.com', 'yahoo.es', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'zoho.com']);
const MAX_IDS = 12, MAX_ENTRIES = 3000;
/** Below this many observed messages the history is too young to call anyone "new". */
const MATURE = 30;

const key = (session: string) => 'nexomail.senders.' + session.replace(/[^\w:.-]/g, '_').slice(0, 120);
const empty = (): History => ({ v: 1, domains: {}, addresses: {}, messages: 0 });
const memory = new Map<string, History>();

function load(session: string): History {
  const cached = memory.get(session);
  if (cached) return cached;
  let history = empty();
  try { const raw = localStorage.getItem(key(session)); if (raw) { const parsed = JSON.parse(raw); if (parsed?.v === 1) history = parsed; } } catch { /* start fresh */ }
  memory.set(session, history);
  return history;
}
function save(session: string, history: History) {
  for (const table of [history.domains, history.addresses]) {
    const entries = Object.entries(table);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => Number(!!b[1].contact) - Number(!!a[1].contact) || b[1].ids.length - a[1].ids.length);
      for (const [name] of entries.slice(MAX_ENTRIES)) delete table[name];
    }
  }
  try { localStorage.setItem(key(session), JSON.stringify(history)); } catch { /* storage full or blocked: keep it in memory */ }
}

const domainOf = (address: string) => (address.split('@').pop() || '').toLowerCase().trim();
const addressesIn = (list: string) => (list.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map(a => a.toLowerCase());
const isSent = (email: Email) => email.labels.includes('SENT');

function note(table: Record<string, Stat>, name: string, email: Email, contact: boolean, verified: boolean): boolean {
  if (!name) return false;
  const stat = table[name] ?? (table[name] = { ids: [], first: email.timestamp });
  let changed = false;
  if (!stat.ids.includes(email.id) && stat.ids.length < MAX_IDS) { stat.ids.push(email.id); changed = true; }
  if (email.timestamp < stat.first) { stat.first = email.timestamp; changed = true; }
  if (contact && !stat.contact) { stat.contact = true; changed = true; }
  if (verified && !stat.verified) { stat.verified = true; changed = true; }
  return changed;
}

/** Adds what is new in these messages to the history. Safe to call repeatedly with the same messages. */
export function observeSenders(session: string, emails: Email[]): void {
  const history = load(session);
  let changed = false;
  for (const email of emails) {
    if (isSent(email)) {
      // People you write to are your contacts.
      for (const address of addressesIn(email.recipient)) {
        changed = note(history.addresses, address, email, true, false) || changed;
        changed = note(history.domains, registrableDomain(domainOf(address)), email, true, false) || changed;
      }
      continue;
    }
    const address = email.sender.toLowerCase();
    const verified = email.insights?.sender?.status === 'verified';
    const before = history.addresses[address]?.ids.includes(email.id);
    changed = note(history.addresses, address, email, false, verified) || changed;
    changed = note(history.domains, registrableDomain(domainOf(address)), email, false, verified) || changed;
    if (!before && address) history.messages++;
  }
  if (changed) save(session, history);
}

/** Whether the sent folder should be read again to learn your contacts (once a day at most). */
export function needsSentScan(session: string): boolean {
  const last = load(session).sentScan ?? 0;
  return Date.now() - last > 24 * 3600 * 1000;
}
export function markSentScan(session: string): void {
  const history = load(session);
  history.sentScan = Date.now();
  save(session, history);
}

const known = (stat?: Stat) => !!stat && (stat.contact || stat.ids.length >= 3 || (stat.verified && stat.ids.length >= 2));
const subjectCore = (subject: string) => subject.toLowerCase().replace(/^(\s*(re|rv|fw|fwd|reenviado|respuesta|aw|tr)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim();

/**
 * Adds the history-based findings to each received message. Returns new objects; the input is untouched,
 * so it is safe to run on every refresh.
 */
export function applySenderContext(session: string, emails: Email[]): Email[] {
  const history = load(session);
  const mature = history.messages >= MATURE || Object.values(history.domains).some(stat => stat.contact);
  const knownDomains = Object.entries(history.domains).filter(([name, stat]) => known(stat) && !FREE_MAIL.has(name)).map(([name]) => ({ domain: name, label: name }));
  return emails.map(email => {
    if (isSent(email) || !email.insights || !email.sender.includes('@')) return email;
    let insights = email.insights;
    const address = email.sender.toLowerCase();
    const domain = domainOf(address), org = registrableDomain(domain);
    const free = FREE_MAIL.has(org);

    // 1. A domain that imitates one you really deal with (your bank, your supplier, your university).
    const imitation = findLookalike(domain, knownDomains);
    if (imitation) insights = addFinding(insights, `La dirección ${domain} se parece a ${imitation.imitates}, con quien sí tienes historial, pero no es la misma. Podría ser una imitación.`, 4);

    // 2. A verified sender that has written to you several times: its click-tracking links are its own.
    const stat = free ? history.addresses[address] : history.domains[org];
    if (!imitation && insights.sender?.status === 'verified' && known(stat) && !free) {
      insights = downgradeMismatches(insights, `Enlaces de seguimiento de ${org}: el remitente está verificado y ya te ha escrito antes.`);
    }

    // 3. First message from someone new (by address for free mail, by organization otherwise).
    const firstTime = mature && !!stat && !stat.contact && stat.ids.length <= 1 && stat.first >= email.timestamp;
    if (firstTime) {
      insights = addFinding(insights, `Es el primer correo que recibes de ${free ? address : org}.`, 0);
      const asksMoney = insights.reasons.some(reason => /cuenta bancaria|credenciales|información financiera|pago/i.test(reason));
      if (asksMoney) insights = addFinding(insights, 'Un remitente con el que nunca has hablado pide dinero o datos: extrema la precaución.', 1);
      // A link that does not go where it says, from someone who never wrote before, is what phishing looks like.
      if (insights.reasons.some(reason => LINK_MISMATCH.test(reason)) && !insights.reasons.includes(MISMATCH_WITH_DECEIT)) {
        insights = addFinding(insights, 'Un enlace no lleva al sitio que muestra y es el primer correo de este remitente: es el patrón típico del phishing.', 2);
      }
    }

    // 4. A stranger answering one of your conversations ("Re: …" from a domain that was not in it).
    const core = subjectCore(email.subject);
    if (core.length >= 6 && core !== email.subject.toLowerCase().trim() && !known(history.domains[org])) {
      const thread = emails.find(other => other.id !== email.id && subjectCore(other.subject) === core);
      if (thread) {
        const participants = (isSent(thread) ? addressesIn(thread.recipient) : [thread.sender.toLowerCase()]).map(a => registrableDomain(domainOf(a)));
        if (participants.length && !participants.includes(org)) {
          insights = addFinding(insights, `Responde a una conversación tuya («${core.length > 60 ? core.slice(0, 60).replace(/\s+\S*$/, '') + '…' : core}») en la que participaba ${participants[0]}, pero llega desde ${org}. Puede ser un hilo secuestrado: confirma con la persona por otro canal.`, 3);
        }
      }
    }
    return insights === email.insights ? email : { ...email, insights };
  });
}
