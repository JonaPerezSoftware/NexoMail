/**
 * Who really sent a message, decided on this device:
 * - the sender authentication the receiving mail service already did (SPF, DKIM, DMARC), read from the
 *   Authentication-Results header that Gmail or Outlook added when the message arrived;
 * - domains that imitate a known one (pichincha-ec.com, paypa1.com).
 * Nothing here contacts the Internet.
 */

export type SenderStatus = 'verified' | 'failed' | 'unknown';
export interface SenderAuth {
  status: SenderStatus;
  /** Domain the verdict is about (the visible From domain). */
  domain: string;
  /** Short, plain explanation for the reader. */
  detail: string;
  spf?: string; dkim?: string; dmarc?: string; compauth?: string;
}
export interface MailHeader { name: string; value: string; }

/** Two-level public suffixes common in the region and in business mail; enough to find the registrable name. */
const TWO_LEVEL = new Set(['com.ec','edu.ec','gob.ec','org.ec','net.ec','fin.ec','com.co','edu.co','gov.co','com.mx','edu.mx','gob.mx','com.pe','edu.pe','gob.pe','com.ar','edu.ar','gob.ar','com.br','gov.br','co.uk','ac.uk','gov.uk','com.au','co.jp','com.es','gob.es','com.ve','com.bo','com.py','com.uy','cl','com.cl']);

/** example.com.ec → example.com.ec; mail.example.com → example.com. */
export function registrableDomain(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_LEVEL.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}
/** The name part of a registrable domain: "pichincha" for pichincha.com and banco.pichincha.com.ec → "pichincha". */
export function baseName(domain: string): string {
  const reg = registrableDomain(domain);
  const parts = reg.split('.');
  return parts[0] || reg;
}
export const sameOrganization = (a: string, b: string) => !!a && !!b && registrableDomain(a) === registrableDomain(b);

/** Pulls key=value results out of one Authentication-Results header. */
function results(value: string) {
  const get = (method: string) => value.match(new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, 'i'))?.[1]?.toLowerCase();
  const fromDomain = value.match(/header\.from\s*=\s*([^\s;]+)/i)?.[1]?.toLowerCase();
  const dkimDomains = [...value.matchAll(/dkim\s*=\s*pass[^;]*?header\.(?:d|i)\s*=\s*@?([^\s;]+)/gi)].map(m => m[1].toLowerCase());
  return { spf: get('spf'), dkim: get('dkim'), dmarc: get('dmarc'), compauth: get('compauth'), fromDomain, dkimDomains };
}

/**
 * Reads the verdict the receiving service wrote. Only the topmost Authentication-Results header counts:
 * it is the one added by Gmail or Outlook; lower ones may have been written by the sender and prove nothing.
 */
export function senderAuthentication(headers: MailHeader[] | undefined, senderAddress: string): SenderAuth {
  const domain = (senderAddress.split('@').pop() || '').toLowerCase();
  const unknown: SenderAuth = { status: 'unknown', domain, detail: 'El servicio de correo no indicó si el remitente pasó la verificación.' };
  if (!headers?.length || !domain) return unknown;
  const header = headers.find(h => h.name.toLowerCase() === 'authentication-results');
  if (!header) return unknown;
  const r = results(header.value);
  const base = { domain, spf: r.spf, dkim: r.dkim, dmarc: r.dmarc, compauth: r.compauth };
  const aligned = (d?: string) => !!d && sameOrganization(d, domain);
  if (r.dmarc === 'fail' || r.compauth === 'fail') {
    return { ...base, status: 'failed', detail: `El servicio de correo comprobó que este mensaje no fue autorizado por ${domain} (DMARC). Puede ser una suplantación.` };
  }
  if ((r.dmarc === 'pass' || r.compauth === 'pass') && (!r.fromDomain || aligned(r.fromDomain))) {
    return { ...base, status: 'verified', detail: `El servicio de correo confirmó que el mensaje viene de ${domain} (DMARC${r.dkim === 'pass' ? ' y DKIM' : ''}).` };
  }
  if (r.dkimDomains.some(aligned)) {
    return { ...base, status: 'verified', detail: `El mensaje está firmado por ${domain} (DKIM).` };
  }
  if ((r.spf === 'fail' || r.spf === 'softfail') && r.dkim !== 'pass') {
    return { ...base, status: 'failed', detail: `El mensaje no se envió desde un servidor autorizado por ${domain} (SPF) y no tiene firma válida.` };
  }
  return { ...base, status: 'unknown', detail: `${domain} no publica una política que permita confirmar al remitente.` };
}

/**
 * Services that rewrite links to count clicks in mass mailings. A verified sender using one of them is
 * normal; the same mismatch from an unverified sender is not.
 */
const TRACKERS = ['api-engage.com','exacttarget.com','sfmc-content.com','list-manage.com','mailchimp.com','mcusercontent.com','sendgrid.net','sendgrid.com','ct.sendgrid.net','mandrillapp.com','mailgun.org','mailgun.net','sparkpostmail.com','hubspotlinks.com','hs-sites.com','hubspotemail.net','mktotracking.com','mkto-','marketo.com','constantcontact.com','rs6.net','cmail19.com','cmail20.com','createsend.com','awstrack.me','amazonses.com','sendibt3.com','sendinblue.com','brevo.com','emltrk.com','mailjet.com','mjt.lu','click.e.','links.e.','email.','trk.','clicks.','go.pardot.com','pardot.com','eloqua.com','en25.com','klclick.com','klaviyo.com','moengage.com','braze.com','iterable.com','customer.io','sailthru.com','epsilon.com','acoustic.com','emarsys.net','cheetahmail.com','responsys.net','bluecore.com','urlgeni.us','doubleclick.net','clicks.mlsend.com','mlsend.com','safelinks.protection.outlook.com'];
export function isTrackingDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return TRACKERS.some(t => t.endsWith('.') || t.endsWith('-') ? d.startsWith(t) || d.includes('.' + t) : d === t || d.endsWith('.' + t));
}

/** Brands commonly imitated in phishing, with their real domains. */
export const KNOWN_BRANDS: { name: string; domains: string[] }[] = [
  { name: 'Google', domains: ['google.com', 'gmail.com', 'youtube.com'] },
  { name: 'Microsoft', domains: ['microsoft.com', 'live.com', 'outlook.com', 'office.com', 'microsoftonline.com', 'hotmail.com'] },
  { name: 'PayPal', domains: ['paypal.com'] },
  { name: 'Apple', domains: ['apple.com', 'icloud.com'] },
  { name: 'Amazon', domains: ['amazon.com', 'amazon.es'] },
  { name: 'Netflix', domains: ['netflix.com'] },
  { name: 'Meta', domains: ['facebook.com', 'instagram.com', 'whatsapp.com', 'meta.com'] },
  { name: 'LinkedIn', domains: ['linkedin.com'] },
  { name: 'DHL', domains: ['dhl.com'] },
  { name: 'Banco Pichincha', domains: ['pichincha.com'] },
  { name: 'Banco Guayaquil', domains: ['bancoguayaquil.com'] },
  { name: 'Produbanco', domains: ['produbanco.com', 'produbanco.com.ec'] },
  { name: 'Banco Internacional', domains: ['bancointernacional.com.ec'] },
  { name: 'Banco Bolivariano', domains: ['bolivariano.com'] },
  { name: 'SRI', domains: ['sri.gob.ec'] },
];

/** Letters that look alike once written: 0→o, 1/l/i→l, rn→m, vv→w… */
function skeleton(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd')
    .replace(/[0]/g, 'o').replace(/[1!|i]/g, 'l').replace(/[3]/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[7]/g, 't')
    .replace(/[^a-z0-9]/g, '');
}
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

export interface Lookalike { domain: string; imitates: string; label: string; }
/**
 * Whether `domain` imitates one of `known` (domains you deal with, or well-known brands): same name with a
 * letter changed, look-alike characters, or the real name with an extra word ("pichincha-seguridad.com").
 * A subdomain or another domain of the same organization is never a look-alike.
 */
export function findLookalike(domain: string, known: { domain: string; label: string }[]): Lookalike | null {
  const d = domain.toLowerCase();
  if (!d.includes('.')) return null;
  const name = baseName(d), shape = skeleton(name);
  if (name.length < 4) return null;
  for (const item of known) {
    const k = item.domain.toLowerCase();
    if (sameOrganization(d, k)) return null; // it IS that organization (or one of its domains)
  }
  for (const item of known) {
    const k = item.domain.toLowerCase();
    const kName = baseName(k), kShape = skeleton(kName);
    if (kName.length < 4) continue;
    const sameName = name === kName; // pichincha.net vs pichincha.com
    const sameShape = shape === kShape; // paypa1 vs paypal
    const typo = kName.length >= 6 && distance(shape, kShape) === 1; // pichinca vs pichincha
    const padded = name !== kName && new RegExp(`(^|[-_.])${kName}([-_.]|$)`).test(name); // pichincha-ec
    const glued = name !== kName && kName.length >= 6 && name.startsWith(kName) && name.length - kName.length <= 12 && /^(seguridad|security|soporte|support|verifica|verify|online|cuenta|account|login|banca|web|app|ec|info|clientes|alerta|alert)/.test(name.slice(kName.length));
    if (sameName || sameShape || typo || padded || glued) return { domain: d, imitates: k, label: item.label };
  }
  return null;
}
