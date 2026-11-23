import { registrableDomain } from '@shared/mail/sender-intel';
import type { MailCategory } from '@shared/mail/mail-insights';
import type { Email } from '../types/email';
import { MANUAL_CATEGORIES } from '../types/email';
import { FREE_MAIL } from './senderHistory';

/**
 * Categories learned from you. When you classify a message by hand (or it already has one of the category labels in
 * Gmail or Outlook), the next messages from that sender get the same category automatically.
 * - By address: «ana@gmail.com is Personal».
 * - By organization, only when two or more of its addresses were classified the same way and none differently
 *   («everything from universidad.edu.ec is Trabajo»). Never for Gmail, Outlook and other shared domains.
 * Kept only in this browser (localStorage), per account; only addresses and the category are stored.
 */
interface Choice { category: MailCategory; at: number }
interface Memory { v: 1; addresses: Record<string, Choice> }

const MAX_ADDRESSES = 2000;
const key = (session: string) => 'nexomail.categories.' + session.replace(/[^\w:.-]/g, '_').slice(0, 120);
const memory = new Map<string, Memory>();

function load(session: string): Memory {
  const cached = memory.get(session);
  if (cached) return cached;
  let value: Memory = { v: 1, addresses: {} };
  try { const raw = localStorage.getItem(key(session)); if (raw) { const parsed = JSON.parse(raw); if (parsed?.v === 1 && parsed.addresses) value = parsed; } } catch { /* start fresh */ }
  memory.set(session, value);
  return value;
}
function save(session: string, value: Memory) {
  const entries = Object.entries(value.addresses);
  if (entries.length > MAX_ADDRESSES) {
    entries.sort((a, b) => b[1].at - a[1].at);
    value.addresses = Object.fromEntries(entries.slice(0, MAX_ADDRESSES));
    memory.set(session, value);
  }
  try { localStorage.setItem(key(session), JSON.stringify(value)); } catch { /* storage full or blocked: keep it in memory */ }
}

const isCategory = (name: string): name is MailCategory => (MANUAL_CATEGORIES as readonly string[]).includes(name);
const orgOf = (address: string) => registrableDomain((address.split('@').pop() || '').toLowerCase());
const isSent = (email: Email) => email.labels.includes('SENT');

/** You chose a category by hand (null: you removed it). The newest choice for an address wins. */
export function learnCategory(session: string, email: Email, category: string | null): void {
  const address = email.sender.toLowerCase().trim();
  if (!address.includes('@') || isSent(email)) return;
  const value = load(session);
  if (category && isCategory(category)) value.addresses[address] = { category, at: Date.now() };
  else delete value.addresses[address];
  save(session, value);
}

/** Messages that already carry a category label (set here, in Gmail or in Outlook) also teach, if newer. */
function observe(session: string, emails: Email[]): void {
  const value = load(session);
  let changed = false;
  for (const email of emails) {
    const category = (email.manualCategories ?? []).find(isCategory);
    const address = email.sender.toLowerCase().trim();
    if (!category || !address.includes('@') || isSent(email)) continue;
    const known = value.addresses[address];
    if (!known || (known.category !== category && email.timestamp > known.at)) {
      value.addresses[address] = { category, at: Math.max(email.timestamp, known?.at ?? 0) };
      changed = true;
    }
  }
  if (changed) save(session, value);
}

/** The category learned for this sender, and how: by its address or by its organization. */
export function learnedCategory(session: string, sender: string): { category: MailCategory; scope: 'address' | 'org'; org: string } | null {
  const value = load(session);
  const address = sender.toLowerCase().trim();
  const org = orgOf(address);
  const own = value.addresses[address];
  if (own) return { category: own.category, scope: 'address', org };
  if (!org || FREE_MAIL.has(org)) return null;
  const sameOrg = Object.entries(value.addresses).filter(([other]) => orgOf(other) === org).map(([, choice]) => choice.category);
  if (sameOrg.length >= 2 && sameOrg.every(category => category === sameOrg[0])) return { category: sameOrg[0], scope: 'org', org };
  return null;
}

/**
 * Puts what was learned first in each message's automatic categories, with the reason. A message classified by hand
 * keeps its own label (that one always wins in the inbox). Also: mail from your own organization (same company
 * domain as your account, not Gmail or Outlook) is work, unless it is a mass mailing or already has a category.
 */
export function applyLearnedCategories(session: string, emails: Email[], accountEmail: string | null): Email[] {
  observe(session, emails);
  const accountOrg = accountEmail ? orgOf(accountEmail) : '';
  return emails.map(email => {
    const insights = email.insights;
    if (!insights || isSent(email) || !email.sender.includes('@') || (email.manualCategories ?? []).length) return email;
    const learned = learnedCategory(session, email.sender);
    let category: MailCategory | null = null, reason = '';
    if (learned) {
      category = learned.category;
      reason = learned.scope === 'address'
        ? `${category}: Aprendido de ti: ya clasificaste correos de ${email.sender.toLowerCase()} como «${category}».`
        : `${category}: Aprendido de ti: clasificaste como «${category}» correos de varias direcciones de ${learned.org}.`;
    } else if (accountOrg && !FREE_MAIL.has(accountOrg) && orgOf(email.sender) === accountOrg && !insights.automated && insights.categories.length === 0) {
      category = 'Trabajo';
      reason = `Trabajo: Viene de tu misma organización (${accountOrg}).`;
    }
    if (!category || insights.categories[0] === category && insights.classificationReasons[0] === reason) return email;
    const others = insights.categories.map((name, index) => [name, insights.classificationReasons[index]] as const).filter(([name]) => name !== category);
    return { ...email, insights: { ...insights, categories: [category, ...others.map(([name]) => name)], classificationReasons: [reason, ...others.map(([, why]) => why)] } };
  });
}
