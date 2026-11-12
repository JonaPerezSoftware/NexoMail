/**
 * Links with their own text inside a message written in NexoMail, as [texto que se ve](https://destino).
 * The same syntax the AI uses. When a message has links it is sent as HTML (with a plain-text copy
 * that shows every destination), so the recipient sees the text and the link goes where it says.
 */
export interface BodyLink { text: string; href: string }

const LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

export function linksIn(body: string): BodyLink[] {
  return [...body.matchAll(LINK)].map(m => ({ text: m[1], href: m[2] }));
}
export const hasLinks = (body: string) => linksIn(body).length > 0;

/** Plain-text copy: "texto (https://destino)", so nothing is hidden in clients without HTML. */
export function toPlainText(body: string): string {
  return body.replace(LINK, (_, text: string, href: string) => (text.trim() === href ? href : `${text} (${href})`));
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML version: everything is escaped except the links NexoMail itself builds. */
export function toHtml(body: string): string {
  let html = '', last = 0;
  for (const m of body.matchAll(LINK)) {
    const start = m.index ?? 0;
    html += escapeHtml(body.slice(last, start)) + `<a href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`;
    last = start + m[0].length;
  }
  html += escapeHtml(body.slice(last));
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${html.replace(/\r?\n/g, '<br>')}</div>`;
}

/** Only web addresses: a link may never run code or open another application. */
export function normalizeUrl(value: string): string | null {
  const raw = value.trim();
  const candidate = /^www\./i.test(raw) ? 'https://' + raw : raw;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') ? url.href : null;
  } catch { return null; }
}

/** Puts [text](url) in place of the selected text (or at the cursor). */
export function insertLink(body: string, start: number, end: number, text: string, url: string): { body: string; cursor: number } {
  const label = text.replace(/[[\]\n]/g, ' ').trim() || url;
  const snippet = `[${label}](${url})`;
  return { body: body.slice(0, start) + snippet + body.slice(end), cursor: start + snippet.length };
}
