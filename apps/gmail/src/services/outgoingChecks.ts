/**
 * Checks on what you are about to SEND (phase 4): data that should never travel by email and
 * replies that go to a different organization than the one that wrote to you. Local, never blocks:
 * it warns before approving and the person decides.
 */
export interface OutgoingWarning { kind: 'sensitive' | 'recipient'; text: string }

const digits = (value: string) => value.replace(/\D/g, '');

/** Luhn check: real card numbers pass it, most random digit runs do not. */
function luhn(number: string): boolean {
  let sum = 0, double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = Number(number[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d; double = !double;
  }
  return sum % 10 === 0;
}

/** Ecuadorian cédula: 10 digits, province 01–24 (or 30), third digit < 6 and a check digit (modulo 10). */
function cedula(number: string): boolean {
  if (!/^\d{10}$/.test(number)) return false;
  const province = Number(number.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30) || Number(number[2]) >= 6) return false;
  const sum = [2, 1, 2, 1, 2, 1, 2, 1, 2].reduce((acc, weight, i) => { let v = Number(number[i]) * weight; if (v > 9) v -= 9; return acc + v; }, 0);
  return (10 - (sum % 10)) % 10 === Number(number[9]);
}

const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function sensitiveData(body: string): OutgoingWarning[] {
  const found: OutgoingWarning[] = [];
  const add = (text: string) => { if (!found.some(w => w.text === text)) found.push({ kind: 'sensitive', text }); };
  const text = norm(body);
  for (const match of body.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const n = digits(match[0]);
    if (n.length >= 13 && n.length <= 19 && luhn(n) && !/^(\d)\1+$/.test(n)) add('Parece incluir un número de tarjeta. Nunca envíes tarjetas por correo.');
  }
  for (const match of body.matchAll(/\b\d{10}\b/g)) if (cedula(match[0])) add('Parece incluir un número de cédula.');
  if (/\b(contrasena|clave|password|passwd|pwd)\b\s*(de [a-z ]{1,20})?\s*[:=]\s*\S{4,}/.test(text) || /\b(contrasena|clave|password|pin)\b\s*(de [a-z ]{1,20})?\s*(es|seria|sera|nueva es)\s*:?\s*(?=\S*[\d!@#$%&*?])\S{4,}/.test(text)) add('Parece incluir una contraseña. Nadie legítimo te la pedirá por correo.');
  if (/\b(codigo|code|otp|pin|token)\b[^\n]{0,25}?[:=]?\s*\b\d{4,8}\b/.test(text) && /\b(verificacion|seguridad|acceso|otp|pin|token|confirmacion|code)\b/.test(text)) add('Parece incluir un código de verificación o PIN. Esos códigos no se comparten con nadie.');
  if (/\bcvv\b|\bcvc\b|codigo de seguridad de (la|tu) tarjeta/.test(text)) add('Menciona el código de seguridad (CVV) de una tarjeta.');
  if (/\b(cuenta|cta\.?)\s*(bancaria|de ahorros|corriente|n[o°º]\.?|numero)?\s*[:#]?\s*\d{8,20}\b/.test(text)) add('Parece incluir un número de cuenta bancaria. Confirma que el destinatario es quien dice ser.');
  if (/\b(frase semilla|seed phrase|clave privada|private key)\b/.test(text)) add('Menciona una frase semilla o clave privada: quien la tenga controla tus fondos.');
  return found;
}

const domainOf = (address: string) => (address.split('@').pop() || '').toLowerCase().trim();
const org = (domain: string) => { const p = domain.split('.'); return p.length > 2 && /^(com|edu|gob|org|net|fin|co|ac)$/.test(p[p.length - 2]) ? p.slice(-3).join('.') : p.slice(-2).join('.'); };

/**
 * A reply that would go to a different organization than the person who wrote (the classic «Reply-To» trick
 * that sends your answer to an attacker).
 */
export function replyWarning(recipient: string, original?: { sender: string; senderName?: string } | null): OutgoingWarning | null {
  if (!original?.sender || !recipient) return null;
  const to = recipient.split(/[;,]/).map(a => a.trim().replace(/^.*<([^>]+)>.*$/, '$1')).filter(Boolean);
  const from = org(domainOf(original.sender));
  const other = to.find(a => from && org(domainOf(a)) !== from);
  return other ? { kind: 'recipient', text: `Respondes a ${other}, pero el correo original lo envió ${original.sender}. Comprueba que la dirección es correcta: es el truco para desviar respuestas a otra persona.` } : null;
}
