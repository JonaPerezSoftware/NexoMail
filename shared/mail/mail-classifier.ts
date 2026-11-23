/**
 * Automatic categories, computed locally (no AI, nothing leaves the computer).
 *
 * Each category collects points from several signals: words in the subject weigh twice as much as in the text, who
 * sends it (a bank, a university, a mailing list, a person writing from a personal account) and the labels the mail
 * service already put. A category is assigned only with enough evidence (2 points), so one loose word in a footer
 * («el equipo de…», «por tu seguridad…») no longer decides it. Mass mailings never count as personal mail.
 */
import { KNOWN_BRANDS, sameOrganization } from './sender-intel';

export type MailCategory = 'Trabajo'|'Personal'|'Importante'|'Finanzas'|'Boletines';

export interface ClassifierInput {
  subject: string; sender: string; senderName?: string;
  /** Plain text of the message (already merged with the HTML text). */
  text: string;
  labels?: string[]; filenames?: string[];
  /** The message came through a mailing list (List-Unsubscribe, List-Id or Precedence: bulk headers). */
  bulk?: boolean;
}

export interface Classification {
  categories: MailCategory[];
  /** One reason per category, in the same order, starting with the category name. */
  reasons: string[];
  specificLabels: string[];
  scores: Partial<Record<MailCategory, number>>;
  /** Sent by a machine (mailing list, no-reply address, promotions): never personal mail. */
  automated: boolean;
}

const normalize = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The categories the person can also set by hand, as Gmail labels or Outlook categories. */
const LABEL_ALIASES: Record<string, MailCategory> = {
  trabajo: 'Trabajo', personal: 'Personal', importante: 'Importante', urgente: 'Importante', finanzas: 'Finanzas',
  boletines: 'Boletines', suscripciones: 'Boletines',
};

/** Fixed phrases of signatures and legal footers that used to trigger categories by themselves. */
const FOOTER_NOISE = /\b(el equipo de [\w .-]{1,30}|equipo de (soporte|atencion|servicio)[\w ]{0,20}|the [\w .-]{1,30} team|por (tu|su) seguridad[^.\n]{0,120}|for your security[^.\n]{0,120}|este (correo|mensaje) (es|fue) (confidencial|enviado)[^\n]{0,200}|aviso de (confidencialidad|privacidad)[^\n]{0,200})/g;

type Where = 'subject'|'any';
/** [category, pattern, where it counts, weight, specific label, reason] */
type Rule = [MailCategory, RegExp, Where, number, string, string];

const RULES: Rule[] = [
  // Money
  ['Finanzas', /\b(factura|facturacion|factura electronica|invoice|recibo|receipt|comprobante|nota de credito)\b/, 'any', 2, 'Facturas y comprobantes', 'menciona una factura, un recibo o un comprobante.'],
  ['Finanzas', /\b(transferencia|pago (recibido|realizado|pendiente|exitoso|confirmado|rechazado)|tu pago|su pago|payment (received|confirmation|failed)|cobro|debito|acreditacion|deposito|reembolso|refund)\b/, 'any', 2, 'Pagos y transferencias', 'habla de un pago, un cobro o una transferencia.'],
  ['Finanzas', /\b(estado de cuenta|saldo|extracto|movimientos|tarjeta de credito|prestamo|credito aprobado|cuota|impuesto|declaracion|retencion|nomina|rol de pagos)\b/, 'any', 2, 'Cuentas, créditos e impuestos', 'trata de cuentas, créditos o impuestos.'],
  ['Finanzas', /(?:\$|usd|eur|€)\s?\d|\d[\d.,]*\s?(?:usd|dolares|euros)\b/, 'any', 1, '', 'incluye importes de dinero.'],
  // Mass mailings and offers
  ['Boletines', /\b(unsubscribe|cancelar (la |tu |su )?suscripcion|darse de baja|darte de baja|dejar de recibir|anular (la )?suscripcion|preferencias de (correo|email|notificacion)|email preferences|manage preferences|view (it )?in (your )?browser|ver (este correo |este mensaje )?en (el |tu |su )?navegador)\b/, 'any', 2, 'Suscripciones', 'tiene un enlace para darse de baja, típico de los envíos masivos.'],
  ['Boletines', /\b(newsletter|boletin|digest|resumen (semanal|mensual|diario)|weekly|novedades de|lo nuevo en)\b/, 'any', 2, 'Boletines informativos', 'es un boletín o resumen periódico.'],
  ['Boletines', /\b(promocion|descuento|oferta especial|ofertas|rebajas?|cupon|black friday|cyber (monday|day)|% off|\d{1,2} ?% de descuento|envio gratis|solo hoy|ultimas horas|liquidacion)\b/, 'any', 1, 'Promociones y ofertas', 'anuncia promociones o descuentos.'],
  // Work and studies
  ['Trabajo', /\b(asignatura|matricula|universidad|semestre|docente|estudiantes?|tesis|sustentacion|calificaci(on|ones)|syllabus|tareas?|aula virtual|catedra|examen)\b/, 'any', 2, 'Comunicaciones académicas', 'tiene referencias académicas (clases, tareas, matrícula…).'],
  ['Trabajo', /\b(reunion|meeting|agenda|acta|proyecto|entregables?|informe|propuesta|cotizacion|contrato|clientes?|proveedor(es)?|entrevista|vacante|postulacion|oferta laboral|curriculum|hoja de vida|orden de compra|presupuesto)\b/, 'any', 2, 'Trabajo y proyectos', 'habla de reuniones, proyectos, clientes o contratos.'],
  ['Trabajo', /\b(invitacion|invitation|convocatoria)\b.{0,80}\b(\d{1,2}:\d{2}|\d{1,2} ?(am|pm)|lunes|martes|miercoles|jueves|viernes|monday|tuesday|wednesday|thursday|friday)\b/, 'any', 2, 'Invitaciones a reuniones', 'es una invitación con fecha y hora.'],
  // Needs attention soon
  ['Importante', /\b(urgente|urgent|importante|accion requerida|action required|ultimo aviso|recordatorio de pago|vence (hoy|manana)|vencimiento|fecha limite|deadline|plazo (final|maximo)|respuesta inmediata)\b/, 'subject', 3, 'Plazos y acciones requeridas', 'el asunto señala un plazo o una acción requerida.'],
  ['Importante', /\b(accion requerida|action required|fecha limite|deadline|vence hoy|antes del \d{1,2} de)\b/, 'any', 1, 'Plazos y acciones requeridas', 'el texto menciona un plazo.'],
  ['Importante', /\b(alerta de seguridad|security alert|nuevo inicio de sesion|new sign-?in|actividad (sospechosa|inusual)|suspicious activity|unusual activity|codigo de verificacion|verification code|restablec\w+ (tu |su )?contrasena|password reset|cambio de contrasena)\b/, 'any', 3, 'Avisos de seguridad de tu cuenta', 'es un aviso sobre la seguridad de tu cuenta.'],
  // People you know
  ['Personal', /\b(cumpleanos|familia|mama|papa|mami|papi|hermano|hermana|hijo|hija|abuel[oa]|tio|tia|primo|prima|abrazos?|besos|te quiero|te extrano|nos vemos|vacaciones|fiesta|boda|bautizo|cena|almuerzo|fin de semana|como estas|que tal estas|un saludo grande)\b/, 'any', 2, 'Correspondencia personal', 'tiene expresiones de una conversación personal.'],
];

const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|noreply|notifications?|notificaciones|alerts?|alertas|news(letter)?|marketing|promo(ciones)?|ofertas|info|mailer|mailing|bounce|updates|hello|hola|team|equipo)([.+_-].*)?@/i;
const MARKETING_SENDER = /^(news(letter)?|marketing|promo(ciones)?|ofertas|mailing|boletin)([.+_-].*)?@/i;
const FREE_MAIL = /@(gmail|googlemail|hotmail|outlook|live|msn|yahoo|icloud|me|proton|protonmail|aol|gmx|zoho)\.[a-z.]{2,6}$/i;
const ACADEMIC = /\.(edu|ac)(\.[a-z]{2})?$|\.edu\.[a-z]{2}$/i;
const FINANCE_BRANDS = KNOWN_BRANDS.filter(brand => /^(banco |paypal$|produbanco$|sri$)/i.test(brand.name));

export function classifyMail(input: ClassifierInput): Classification {
  const subject = normalize(input.subject);
  // Only the start of a long text counts: legal footers and quoted replies come at the end.
  const body = normalize(input.text.slice(0, 6000)).replace(FOOTER_NOISE, ' ');
  const sender = input.sender.toLowerCase().trim();
  const senderDomain = sender.split('@').pop() || '';
  const labels = (input.labels || []).map(label => label.toUpperCase());

  const scores: Partial<Record<MailCategory, number>> = {};
  const best: Partial<Record<MailCategory, { weight: number; reason: string; specific: string }>> = {};
  const specific: [string, MailCategory][] = [];
  const add = (category: MailCategory, weight: number, reason: string, label = '') => {
    scores[category] = (scores[category] ?? 0) + weight;
    if (!best[category] || weight > best[category]!.weight) best[category] = { weight, reason, specific: label };
    if (label && !specific.some(([name]) => name === label)) specific.push([label, category]);
  };

  // 1. What the person already decided (their own labels or Outlook categories) always wins.
  for (const label of input.labels || []) {
    const category = LABEL_ALIASES[normalize(label).trim()];
    if (category) add(category, 10, `ya tiene la etiqueta «${label}» en tu correo.`);
  }

  // 2. What the mail service knows. Gmail's «Principal» tab (CATEGORY_PERSONAL) holds almost everything, so it says
  //    nothing about personal mail; IMPORTANT is Gmail's own guess and only helps a little.
  const automated = !!input.bulk || AUTOMATED_SENDER.test(sender) || labels.some(label => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES'].includes(label));
  if (labels.includes('CATEGORY_PROMOTIONS')) add('Boletines', 3, 'Gmail lo puso en Promociones.', 'Promociones y ofertas');
  if (labels.includes('CATEGORY_SOCIAL')) add('Boletines', 2, 'Gmail lo puso en Social (avisos de redes sociales).', 'Redes sociales');
  if (labels.includes('CATEGORY_FORUMS')) add('Boletines', 2, 'Gmail lo puso en Foros (listas de correo).', 'Foros y listas');
  if (labels.includes('IMPORTANT')) add('Importante', 1, 'Gmail lo marcó como importante.');
  if (input.bulk) add('Boletines', 2, 'llegó por una lista de correo (envío masivo).', 'Suscripciones');
  if (MARKETING_SENDER.test(sender)) add('Boletines', 2, `lo envía una dirección de marketing (${sender.split('@')[0]}@…).`, 'Promociones y ofertas');

  // 3. Who sends it.
  if (FINANCE_BRANDS.some(brand => brand.domains.some(domain => sameOrganization(domain, senderDomain)))) add('Finanzas', 3, `lo envía una entidad financiera (${senderDomain}).`, 'Bancos y entidades financieras');
  else if (/(^|[.-])(banco|bank|pagos?|payments?|billing|facturacion|tesoreria|contabilidad)([.-]|$)/.test(senderDomain) || /^(billing|facturacion|facturas|pagos|payments|cobranzas?|tesoreria|contabilidad)[.+_-]?.*@/.test(sender)) add('Finanzas', 2, `la dirección del remitente es de pagos o facturación (${sender}).`, 'Facturas y comprobantes');
  if (ACADEMIC.test(senderDomain)) add('Trabajo', 2, `lo envía una institución educativa (${senderDomain}).`, 'Comunicaciones académicas');
  if ((input.filenames || []).some(name => /\.ics$/i.test(name))) add('Trabajo', 2, 'trae una invitación de calendario (.ics).', 'Invitaciones a reuniones');
  if (!automated && FREE_MAIL.test(sender)) add('Personal', 1, 'lo escribe una persona desde una cuenta personal.');

  // 4. What it says: the subject weighs double; each rule counts once.
  for (const [category, pattern, where, weight, label, reason] of RULES) {
    if (pattern.test(subject)) add(category, weight * 2, 'el asunto ' + reason.replace(/^el (asunto|texto) /, ''), label);
    else if (where === 'any' && pattern.test(body)) add(category, weight, (reason.startsWith('el ') ? '' : 'el texto ') + reason, label);
  }
  if (/\bno (es )?(urgente|importante)\b/.test(subject + ' ' + body)) scores.Importante = Math.min(scores.Importante ?? 0, 1);

  // 5. Mass mailings are never personal, rarely work, and their «¡urgente!» is marketing.
  if (automated) {
    delete scores.Personal;
    if (scores.Trabajo !== undefined && !(scores.Trabajo >= 10)) scores.Trabajo = ACADEMIC.test(senderDomain) ? scores.Trabajo : scores.Trabajo / 2;
    if ((scores.Boletines ?? 0) >= 3 && scores.Importante !== undefined && scores.Importante < 10 && !/seguridad/i.test(best.Importante?.specific ?? '')) scores.Importante /= 2;
  }

  const categories = (Object.entries(scores) as [MailCategory, number][])
    .filter(([, score]) => score >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => category);
  const reasons = categories.map(category => `${category}: ${best[category]!.reason.charAt(0).toUpperCase()}${best[category]!.reason.slice(1)}`);
  const specificLabels = specific.filter(([, category]) => categories.includes(category)).map(([label]) => label);
  return { categories, reasons, specificLabels, scores, automated };
}
