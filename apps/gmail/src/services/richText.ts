import type { MailFile } from '../types/email';
import { linksIn, toHtml as linksToHtml } from './mailLinks';

/**
 * Formatted messages written in NexoMail's editor (bold, lists, colours, images in the text, links).
 *
 * The editor works on HTML, but nothing it produces is trusted: every value goes through sanitizeHtml, which keeps
 * only formatting (an allow-list of tags, attributes and CSS properties) and drops scripts, events, forms, frames,
 * styles that load anything and links that are not web or mail addresses. The plain-text copy (htmlToText) is
 * what the AI and the sensitive-data checks read, and it travels with the HTML in every message.
 */

const BLOCKS = new Set(['P', 'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3']);
const ALLOWED = new Set(['P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'IMG', 'FONT', 'HR', 'SUB', 'SUP']);
/** Removed with everything inside them (not just unwrapped). */
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'TITLE', 'HEAD', 'VIDEO', 'AUDIO', 'CANVAS']);
const STYLE_PROPS = new Set(['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-align', 'margin-left', 'padding-left', 'width', 'max-width', 'height']);
/** Sizes of the old «font size» attribute (what the browser writes) as CSS. */
const FONT_SIZES: Record<string, string> = { '1': '10px', '2': '12px', '3': '14px', '4': '18px', '5': '24px', '6': '32px', '7': '48px' };
const SAFE_VALUE = /^[#(),.%\w\s-]{1,60}$/;
const IMAGE_DATA = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function cleanStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const [rawName, ...rest] = declaration.split(':');
    const name = rawName?.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (!name || !value || !STYLE_PROPS.has(name)) continue;
    if (!SAFE_VALUE.test(value) || /url|expression|javascript|@import/i.test(value)) continue;
    kept.push(`${name}:${value}`);
  }
  return kept.join(';');
}

function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^mailto:[^\s"<>]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function cleanNode(node: Node, doc: Document): Node[] {
  if (node.nodeType === Node.TEXT_NODE) return [doc.createTextNode(node.textContent ?? '')];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (DROP_WITH_CONTENT.has(tag)) return [];
  const children = [...element.childNodes].flatMap((child) => cleanNode(child, doc));
  if (!ALLOWED.has(tag)) return children; // unknown wrappers (section, table…) keep only their content
  const out = doc.createElement(tag === 'FONT' ? 'span' : tag.toLowerCase());
  let style = cleanStyle(element.getAttribute('style') ?? '');
  if (tag === 'FONT') {
    const color = element.getAttribute('color');
    const size = FONT_SIZES[element.getAttribute('size') ?? ''];
    if (color && SAFE_VALUE.test(color)) style = `color:${color}${style ? ';' + style : ''}`;
    if (size) style = `font-size:${size}${style ? ';' + style : ''}`;
  }
  if (tag === 'A') {
    const href = safeHref(element.getAttribute('href') ?? '');
    if (!href) return children; // a link to anywhere else keeps its text, without the link
    out.setAttribute('href', href);
  }
  if (tag === 'IMG') {
    const src = (element.getAttribute('src') ?? '').trim();
    if (!/^cid:[\w.@-]+$/.test(src) && !IMAGE_DATA.test(src)) return [];
    out.setAttribute('src', src);
    const alt = element.getAttribute('alt');
    if (alt) out.setAttribute('alt', alt.slice(0, 200));
    for (const dim of ['width', 'height']) { const v = element.getAttribute(dim); if (v && /^\d{1,4}$/.test(v)) out.setAttribute(dim, v); }
  }
  if (style) out.setAttribute('style', style);
  for (const child of children) out.appendChild(child);
  return [out];
}

/** Keeps only formatting. Safe to put in the page and to send. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const box = doc.createElement('div');
  for (const node of [...doc.body.childNodes].flatMap((child) => cleanNode(child, doc))) box.appendChild(node);
  return box.innerHTML;
}

/** Plain-text copy: links as «texto (dirección)», lists with • or numbers, one line per paragraph. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  let out = '';
  const breakLine = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const walk = (node: Node, listIndex: { n: number } | null) => {
    if (node.nodeType === Node.TEXT_NODE) { out += (node.textContent ?? '').replace(/\s+/g, ' '); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (tag === 'BR') { out += '\n'; return; }
    if (tag === 'IMG') { out += '[imagen]'; return; }
    if (tag === 'A') {
      const text = element.textContent?.trim() ?? '';
      const href = element.getAttribute('href') ?? '';
      out += !href || text === href || `mailto:${text}` === href ? text || href : `${text} (${href})`;
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) breakLine();
    if (tag === 'LI') out += listIndex ? `${++listIndex.n}. ` : '• ';
    const nextIndex = tag === 'OL' ? { n: 0 } : tag === 'UL' ? null : listIndex;
    for (const child of element.childNodes) walk(child, nextIndex);
    if (block) breakLine();
  };
  for (const child of doc.body.childNodes) walk(child, null);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text as written by the AI or a person (with [texto](dirección) links) as editable HTML. */
export function textToHtml(text: string): string {
  const html = linksToHtml(text);
  return html.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
}

/** Links of a formatted message, to show where each one really goes before sending. */
export function linksInHtml(html: string): { text: string; href: string }[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return [...doc.querySelectorAll('a[href]')].map((a) => ({ text: a.textContent?.trim() || a.getAttribute('href') || '', href: a.getAttribute('href') || '' }))
    .filter((link) => /^https?:/i.test(link.href));
}

/** True when the text carries anything only HTML can show (formatting, lists, images, links). */
export function hasFormatting(html: string): boolean {
  return /<(?:b|strong|i|em|u|s|strike|del|ul|ol|blockquote|a|img|span[^>]*style|p[^>]*style|div[^>]*style|sub|sup|hr)\b/i.test(html);
}

/**
 * Images pasted or inserted in the text travel as images inside the message (like Gmail): each data: image becomes
 * an inline attachment and the HTML points to it with cid:. Returns the new HTML and those attachments.
 */
export function extractInlineImages(html: string): { html: string; images: MailFile[] } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const images: MailFile[] = [];
  for (const img of doc.querySelectorAll('img')) {
    const match = (img.getAttribute('src') ?? '').match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,(.+)$/i);
    if (!match) continue;
    const data = match[2].replace(/\s/g, '');
    const cid = `img-${crypto.randomUUID().slice(0, 8)}@nexomail`;
    const extension = match[1].split('/')[1].replace('jpeg', 'jpg');
    images.push({ name: `imagen-${images.length + 1}.${extension}`, type: match[1].toLowerCase(), size: Math.floor(data.length * 3 / 4), data, inline: true, cid });
    img.setAttribute('src', `cid:${cid}`);
  }
  return { html: doc.body.innerHTML, images };
}

/** The other way round, to show or edit a message: cid: images back to their data. Missing ones are dropped. */
export function resolveInlineImages(html: string, files: MailFile[] = []): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const img of doc.querySelectorAll('img[src^="cid:"]')) {
    const cid = img.getAttribute('src')!.slice(4);
    const file = files.find((f) => f.inline && f.cid === cid);
    if (file) img.setAttribute('src', `data:${file.type};base64,${file.data}`);
    else img.replaceWith(doc.createTextNode('[imagen no conservada]'));
  }
  return doc.body.innerHTML;
}

/** What goes out: the formatting, with the look email clients expect (Gmail's own quote style, images that fit). */
export function toEmailHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeHtml(html)}</body>`, 'text/html');
  for (const quote of doc.querySelectorAll('blockquote')) quote.setAttribute('style', 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex');
  for (const img of doc.querySelectorAll('img')) img.setAttribute('style', `max-width:100%;height:auto${img.getAttribute('style') ? ';' + img.getAttribute('style') : ''}`);
  for (const p of doc.querySelectorAll('p')) if (!p.getAttribute('style')) p.setAttribute('style', 'margin:0 0 1em');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">${doc.body.innerHTML}</div>`;
}

/**
 * Saved drafts keep their formatting in the same text column of PostgreSQL, behind this mark. Images are not kept
 * in drafts (they would exceed the size the server stores); the draft says so.
 */
export const RICH_DRAFT_MARK = '<!--nexomail:html-->';
export function draftBodyFromHtml(html: string): { body: string; droppedImages: boolean } {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeHtml(html)}</body>`, 'text/html');
  const imgs = [...doc.querySelectorAll('img')];
  imgs.forEach((img) => img.replaceWith(doc.createTextNode('[imagen]')));
  return { body: RICH_DRAFT_MARK + doc.body.innerHTML, droppedImages: imgs.length > 0 };
}
export function draftHtml(body: string): string {
  return body.startsWith(RICH_DRAFT_MARK) ? sanitizeHtml(body.slice(RICH_DRAFT_MARK.length)) : textToHtml(body);
}
export function draftText(body: string): string {
  return body.startsWith(RICH_DRAFT_MARK) ? htmlToText(body.slice(RICH_DRAFT_MARK.length)) : body;
}

/** Addresses written in a Para/Cc/Cco field, separated by commas or semicolons. */
export function addressList(value: string): string[] {
  return value.split(/[;,]/).map((part) => part.trim()).map((part) => part.match(/<([^>]+)>/)?.[1] ?? part).filter(Boolean);
}
export const validAddress = (value: string) => /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/.test(value.trim());

/** For text messages: the links the editor would show. */
export { linksIn };
