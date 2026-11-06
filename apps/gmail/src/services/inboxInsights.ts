import { analyzeMail } from '@shared/mail/mail-insights';
import type { Email } from '../types/email';
import { normalizeText } from './mailIntent';

/**
 * Answers computed from the loaded mail, with or without AI: the same question always gives the
 * same list, and it keeps working when the model is busy.
 */
export type InsightRequest = 'briefing' | 'awaiting' | 'risks';

const AUTOMATED_SENDER = /(?:^|[._+-])(?:no-?reply|do-?not-?reply|notifica\w*|notifications?|alerts?|mailer-daemon|postmaster|bounce\w*|news(?:letter)?|marketing|updates?|soporte-automatico)(?:[._+-]|@)/i;
const AUTOMATED_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM'];
/** Questions and requests addressed to the reader. */
const ASKS_FOR_REPLY = /\?|\b(?:puedes|podrias|podria|pueden|confirma\w*|por favor|favor de|necesito|necesitamos|quedo atent\w*|espero (?:tu|su) respuesta|me avisas|avisame|me dices|me comentas|responde\w*|tu respuesta|su respuesta|revis\w*|aprueb\w*|cuando puedes|te parece|nos reunimos|disponible|disponibilidad)\b/;

const isSent = (email: Email) => email.labels.includes('SENT');

/** Notifications, newsletters and promotions: nobody is waiting for an answer to these. */
export function isAutomated(email: Email): boolean {
  if (AUTOMATED_SENDER.test(email.sender)) return true;
  if (email.labels.some((label) => AUTOMATED_LABELS.includes(label))) return true;
  if (['Suscripciones', 'Notificaciones', 'Boletines'].includes(email.category)) return true;
  return insightsOf(email).categories.includes('Boletines');
}

export function insightsOf(email: Email) {
  return email.insights ?? analyzeMail({ subject: email.subject, sender: email.sender, senderName: email.senderName, text: email.body || email.snippet, labels: [...email.labels, email.category] });
}

const newestFirst = (list: Email[]) => [...list].sort((a, b) => b.timestamp - a.timestamp);

/** Messages written by a person that ask something of the reader. */
export function awaitingReply(emails: Email[]): Email[] {
  return newestFirst(emails.filter((email) => !isSent(email) && !email.trashed && !isAutomated(email)
    && ASKS_FOR_REPLY.test(normalizeText(`${email.subject}\n${email.snippet}\n${email.body.slice(0, 2000)}`))));
}

export function riskyEmails(emails: Email[]): Email[] {
  return newestFirst(emails.filter((email) => insightsOf(email).level !== 'none'))
    .sort((a, b) => Number(insightsOf(b).level === 'high') - Number(insightsOf(a).level === 'high'));
}

/** The newest message a person (not a system) sent to this account. */
export function latestFromPerson(emails: Email[]): Email | null {
  return newestFirst(emails.filter((email) => !isSent(email) && !email.trashed && !isAutomated(email)))[0] ?? null;
}

export function wantsLatestFromPerson(prompt: string): boolean {
  const text = normalizeText(prompt);
  return /\b(?:ultimo|ultima|mas reciente)\b/.test(text) && /\b(?:persona|alguien|humano)\b/.test(text);
}

export function detectInsightRequest(prompt: string): InsightRequest | null {
  const text = normalizeText(prompt);
  if (/\b(?:sospechos\w*|phishing|fraude\w*|estafa\w*|peligros\w*|malicios\w*|riesgos?)\b/.test(text)) return 'risks';
  if (/\b(?:por|sin) (?:responder|contestar)\b|\b(?:esperando|espera|esperan|pendientes?|necesitan?|requieren?)\b.{0,40}\b(?:respuesta|responder|contestar)\b/.test(text)) return 'awaiting';
  if (/\bresumen del dia\b|\bponme al dia\b|\bque hay de nuevo\b|\bresumen de (?:mi|la) bandeja\b/.test(text)) return 'briefing';
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A list item with the subject in bold and the sender and date on a second, lighter line. */
const item = (email: Email, extra?: string) =>
  `- **${email.subject || '(Sin asunto)'}**\n  ${email.senderName}${email.date ? ` · ${email.date}` : ''}${extra ? `\n  ${extra}` : ''}`;
const quoted = (list: Email[]) => list.slice(0, 3).map((email) => `«${email.subject}»`).join(' · ');

export function describeInsight(kind: InsightRequest, emails: Email[], isReal: boolean): string {
  const scope = isReal ? `Analicé los ${emails.length} correos más recientes de tu bandeja.` : `Analicé los ${emails.length} correos de demostración.`;
  if (kind === 'risks') {
    const found = riskyEmails(emails);
    if (!found.length) return `**Sin señales de riesgo**\n${scope} Ninguno muestra señales de phishing o fraude.`;
    const items = found.slice(0, 8).map((email) => {
      const info = insightsOf(email);
      return item(email, `${info.level === 'high' ? '⚠️ ' : ''}${info.label}${info.reasons[0] ? `: ${info.reasons[0]}` : ''}`);
    });
    const more = found.length > 8 ? `\nY ${plural(found.length - 8, 'correo más', 'correos más')} en la pestaña Correo (filtro «Con alertas»).` : '';
    return `**${plural(found.length, 'correo con señales de riesgo', 'correos con señales de riesgo')}**\n${scope}\n\n${items.join('\n')}${more}\n\nNo abras sus enlaces ni adjuntos, y confirma cualquier pago o dato por otro canal.`;
  }
  if (kind === 'awaiting') {
    const found = awaitingReply(emails);
    if (!found.length) return `**Nada pendiente de respuesta**\n${scope} Ningún correo de una persona parece esperar tu respuesta.`;
    const more = found.length > 8 ? `\nY ${plural(found.length - 8, 'más', 'más')}.` : '';
    return `**${plural(found.length, 'correo espera tu respuesta', 'correos esperan tu respuesta')}**\n${scope} Estos son de personas y te hacen una pregunta o petición:\n\n${found.slice(0, 8).map((email) => item(email)).join('\n')}${more}\n\nPara contestar, pídeme por ejemplo «Responde a ${found[0].senderName}».`;
  }
  const unread = emails.filter((email) => !email.read && !isSent(email));
  const urgent = emails.filter((email) => email.priority === 'urgent' || email.priority === 'high');
  const waiting = awaitingReply(emails);
  const risky = riskyEmails(emails);
  const automated = emails.filter(isAutomated);
  const parts = [
    '**Resumen de tu bandeja**',
    scope,
    '',
    `- **${plural(unread.length, 'sin leer', 'sin leer')}**${unread.length ? `\n  El más reciente: «${newestFirst(unread)[0].subject}»` : ''}`,
    `- **${plural(urgent.length, 'urgente o importante', 'urgentes o importantes')}**${urgent.length ? `\n  ${quoted(urgent)}` : ''}`,
    `- **${plural(waiting.length, 'espera tu respuesta', 'esperan tu respuesta')}**${waiting.length ? `\n  ${waiting.slice(0, 3).map((email) => `«${email.subject}» de ${email.senderName}`).join(' · ')}` : ''}`,
    `- **${plural(risky.length, 'con señales de riesgo', 'con señales de riesgo')}**${risky.length ? '\n  Revísalos antes de abrir enlaces o adjuntos' : ''}`,
    `- **${plural(automated.length, 'notificación o boletín', 'notificaciones o boletines')}**${automated.length ? '\n  Puedes limpiarlos con «Limpiar promociones»' : ''}`,
  ];
  return parts.join('\n');
}
