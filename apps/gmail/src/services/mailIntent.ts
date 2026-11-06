import type { Email } from '../types/email';

export type MailIntent = 'negated' | 'restore' | 'delete' | 'send' | 'other';

/** Stays visible in the draft so a message without real content cannot be approved by accident. */
export const MANUAL_BODY_PLACEHOLDER = '[Escribe aquí tu mensaje antes de aprobar]';

const DELETE_VERB = /\b(?:(?:elimin|borr)(?:a|ar|e|en|es|emos|alo|ala|alos|alas|arlo|arla|arlos|arlas|ame|amelo|amela)|suprim(?:e|ir|elo|ela|elos|elas))\b/;
const TO_TRASH = /\b(?:envia|enviar|enviame|envialo|enviala|manda|mandar|mandalo|mandala|mueve|mover|muevelo|muevela|pasa|pasar|lleva|llevar|tira|tirar|echa|echar)\b[^.;]{0,60}\bpapelera\b/;
/** "Recupera" alone can mean a password, so recovering mail needs trash or a deleted message in the sentence. */
const RESTORE = /\brestaur(?:a|ar|alo|ala|alos|alas|arlo|arla|arlos|arlas)\b|\b(?:recuper|sac|devuelv|regres)\w*\b[^.;]{0,60}\b(?:papelera|eliminad\w*|borrad\w*)\b|\b(?:recuper|sac|devuelv|regres)\w*\b[^.;]{0,60}\bque\s+(?:elimine|borre)\b|\b(?:mueve|mover|muevelo|muevela|pasa|pasar|lleva|llevar)\b[^.;]{0,60}\b(?:de|desde|fuera\s+de)\s+la\s+papelera\b/;
const SEND_VERB = /\b(?:envia|enviar|enviale|eviale|evia|enbia|enbiale|enviame|envie|envien|envies|manda|mandar|mandale|mande|mandes|responde|responder|respondele|responda|respondas|contesta|contestar|contestale|contestes|redacta|redactar|redacte|redactes)\b|\b(?:un|nuevo|otro)\s+correo\s+a\b|^\s*correo\s+a\b/;
const NEGATION = /\b(?:no|nunca|jamas|evita|evitar|sin)\s+(?:\w+\s+){0,3}?(?:restaur\w*|recuper\w*|(?:elimin|borr)\w*|suprim\w*|envi[ae]\w*|mand[ae]\w*|respond\w*|contest\w*|redact\w*)\b/;
const CLEANUP_WORD = /\b(?:limpia|limpiar|limpieza)\b/;
const BULK_NOUN = /\b(?:spam|suscripcion(?:es)?|promocion(?:es)?|publicidad|boletin(?:es)?|newsletters?)\b/g;
const EMAIL_ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const QUOTED = /["“«]([^"”»]{2,})["”»]/;

/** Words that describe the request itself and say nothing about which message is meant. */
const STOP_WORDS = new Set(`
a al algo ante asunto ayer ayudame aquel aquella bandeja cada como con confirma correo correos cual de del desde dice dile
diciendo el ella ella ellos email emails en entrada es esa ese esta estas este estos favor gmail hola hoy haz hazme la las
le les leida leidas leido leidos lo los llamado llego mail mails me mensaje mensajes mi mis mas nos nuevo o otro para pero
podrias por porque puedes quiero que quien recibi recibido reciente remitente respuesta se semana si sobre su sus tiene
titulado todas todos tu tus un una unas uno unos ultima ultimo y ya anterior antiguo antigua viejo vieja enviado enviada
enviados enviadas envio mando necesito papelera primero primera carpeta salida recibidos recibidas enviaste mandado mandados
restaura restaurar restauralo restaurala recupera recuperar recuperalo recuperala saca sacar sacalo devuelve regresa eliminado eliminada eliminados eliminadas borrado borrada borrados borradas elimine borre
elimina eliminar elimine eliminen elimines eliminemos eliminalo eliminala eliminalos eliminalas eliminarlo eliminarla eliminarlos eliminarlas eliminame
borra borrar borre borren borres borremos borralo borrala borralos borralas borrarlo borrarla borrarlos borrarlas borrame
suprime suprimir suprimelo suprimela mueve mover muevelo muevela pasa pasar lleva llevar tira tirar echa echar
envia enviar enviale enviame envie envien envies manda mandar mandale mande mandes responde responder respondele responda
respondas contesta contestar contestale contestes redacta redactar redacte redactes
`.trim().split(/\s+/));

export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** The verb the sentence starts from wins, so "pide que borre el archivo" stays a message. */
export function detectIntent(prompt: string): MailIntent {
  const text = normalizeText(prompt);
  if (NEGATION.test(text)) return 'negated';
  if (RESTORE.test(text)) return 'restore';
  if (TO_TRASH.test(text)) return 'delete';
  const deleteAt = text.search(DELETE_VERB);
  const sendAt = text.search(SEND_VERB);
  if (deleteAt >= 0 && (sendAt < 0 || deleteAt < sendAt)) return 'delete';
  if (sendAt >= 0) return 'send';
  return 'other';
}

function targetTokens(text: string): string[] {
  return [...new Set(
    text
      .replace(EMAIL_ADDRESS, ' ')
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 || /\d/.test(word))
      .filter((word) => !STOP_WORDS.has(word))
  )];
}

/** True for "elimina los boletines"; false when a sender or subject narrows it down. */
export function isBulkCleanupRequest(prompt: string): boolean {
  const text = normalizeText(prompt);
  const hasBulkNoun = text.search(BULK_NOUN) >= 0;
  if (!hasBulkNoun && !CLEANUP_WORD.test(text)) return false;
  if (EMAIL_ADDRESS.test(text)) {
    EMAIL_ADDRESS.lastIndex = 0;
    return false;
  }
  EMAIL_ADDRESS.lastIndex = 0;
  return targetTokens(text.replace(BULK_NOUN, ' ').replace(CLEANUP_WORD, ' ')).length === 0;
}

function wordMatches(word: string, token: string): boolean {
  if (word === token) return true;
  if (token.length >= 4 && word.startsWith(token)) return true;
  return token.endsWith('s') && word === token.slice(0, -1);
}

const isSentMail = (email: Email) => email.labels.includes('SENT');

/** A received message always has the account owner as recipient, so only sent mail is matched by recipient. */
function searchableWords(email: Email): string[] {
  const recipient = isSentMail(email) ? email.recipient : '';
  return normalizeText(`${email.senderName} ${email.sender} ${recipient} ${email.subject}`).split(/[^a-z0-9]+/);
}

function involvesAddress(email: Email, address: string): boolean {
  if (email.sender.toLowerCase() === address) return true;
  return isSentMail(email) && email.recipient.toLowerCase().includes(address);
}

/** Shows who it went to for sent mail, since its sender is always the account owner. */
export function describeEmail(email: Email): string {
  return isSentMail(email) ? `Para ${email.recipient}: ${email.subject}` : `${email.senderName}: ${email.subject}`;
}

/** True when the sentence is about mail the person sent, not "enviado por" someone else. */
export function isSentMailRequest(prompt: string): boolean {
  return /\b(?:en|de)\s+(?:la\s+)?(?:carpeta\s+de\s+)?enviados\b|\bque\s+(?:le\s+|les\s+)?(?:envie|mande)\b|\bbandeja de salida\b|\bultimo\s+(?:correo\s+|mensaje\s+)?enviado\b/.test(normalizeText(prompt));
}

/** Gmail search for the named message across all folders. Gmail itself leaves out trash and spam. */
export function buildMailSearchQuery(prompt: string): string | null {
  const text = normalizeText(prompt);
  const sentOnly = isSentMailRequest(prompt) ? 'in:sent ' : '';
  const addresses = (text.match(EMAIL_ADDRESS) ?? []).map((address) => address.toLowerCase());
  if (addresses.length) return `${sentOnly}{${addresses.map((a) => `from:${a} to:${a}`).join(' ')}}`;
  const quoted = prompt.match(QUOTED)?.[1];
  if (quoted) return `${sentOnly}subject:"${quoted.replace(/"/g, ' ').trim()}"`;
  const tokens = targetTokens(text.replace(BULK_NOUN, ' '));
  if (tokens.length) return `${sentOnly}${tokens.map((t) => `{from:${t} to:${t} subject:${t}}`).join(' ')}`;
  return sentOnly ? sentOnly.trim() : null;
}

export interface TargetSearch {
  /** No sender, subject or reference was given, so nothing can be chosen safely. */
  missingCriteria: boolean;
  matches: Email[];
  wantsAll: boolean;
}

/** Finds only the messages the sentence names. It never falls back to arbitrary messages. */
export function findNamedEmails(prompt: string, emails: Email[]): TargetSearch {
  const text = normalizeText(prompt);
  const wantsAll = /\b(?:todos|todas)\b/.test(text);
  const wantsNewest = /\b(?:ultimo|ultima|mas reciente)\b/.test(text);
  const pickNewest = (found: Email[]) => (wantsNewest && !wantsAll ? found.slice(0, 1) : found);

  const addresses = (text.match(EMAIL_ADDRESS) ?? []).map((address) => address.toLowerCase());
  if (addresses.length) {
    return { missingCriteria: false, wantsAll, matches: pickNewest(emails.filter((email) => addresses.some((address) => involvesAddress(email, address)))) };
  }

  const quoted = prompt.match(QUOTED)?.[1];
  if (quoted) {
    const phrase = normalizeText(quoted);
    return { missingCriteria: false, wantsAll, matches: pickNewest(emails.filter((email) => normalizeText(email.subject).includes(phrase))) };
  }

  const tokens = targetTokens(text.replace(BULK_NOUN, ' '));
  if (!tokens.length) {
    return { missingCriteria: !wantsNewest, wantsAll, matches: wantsNewest ? emails.slice(0, 1) : [] };
  }
  const matches = emails.filter((email) => {
    const words = searchableWords(email);
    return tokens.every((token) => words.some((word) => wordMatches(word, token)));
  });
  return { missingCriteria: false, wantsAll, matches: pickNewest(matches) };
}

/** A reply can be phrased loosely, so it accepts one clear best match with at least two shared words. */
export function findReplyTarget(prompt: string, emails: Email[]): Email | null {
  const named = findNamedEmails(prompt, emails);
  if (named.matches.length === 1) return named.matches[0];
  if (named.matches.length > 1 || named.missingCriteria) return null;
  const tokens = targetTokens(normalizeText(prompt));
  const scored = emails
    .map((email) => {
      const words = searchableWords(email);
      return { email, score: tokens.filter((token) => words.some((word) => wordMatches(word, token))).length };
    })
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  return best && best.score >= 2 && best.score > (second?.score ?? 0) ? best.email : null;
}

export function firstEmailAddress(prompt: string): string | null {
  return prompt.match(EMAIL_ADDRESS)?.[0] ?? null;
}

export function isValidEmailAddress(value: string): boolean {
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && value.length <= 254;
}

/** Uses only what the person dictated, such as "diciendo que llego tarde". */
export function dictatedBody(prompt: string): string | null {
  const match = prompt.match(/\b(?:diciendo|diciéndole|diciendole|dile|para decirle|indicando|informando)\s+(?:que\s+)?(.{3,})$/is);
  if (!match) return null;
  const text = match[1].trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
