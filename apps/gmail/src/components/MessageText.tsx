import type { ReactNode } from 'react';

/**
 * Renders the agent's answers (AI or local rules) as readable blocks: headings, bulleted and
 * numbered lists with a secondary line, and paragraphs. Everything becomes React nodes, so the
 * text is never treated as HTML.
 */

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; items: { text: string; sub: string[]; number?: number }[] }
  | { kind: 'paragraph'; lines: string[] };

const BULLET = /^\s{0,3}(?:[•\-*·])\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,2})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,4}\s+(.*)$/;
/** A whole line in bold, such as "**Resumen de tu bandeja**", reads as a title. */
const BOLD_LINE = /^\s*\*\*([^*]+)\*\*:?\s*$/;
const SUB_LINE = /^\s{2,}\S/;
/** A link to a loaded mail, written as [Asunto](#correo/id). */
const MAIL_LINK = /\[([^\]]+)\]\(#correo\/([^)\s]+)\)/g;

/** Opens a loaded mail by its id. */
export type OpenMail = (id: string) => void;

/** Internal identifiers help the agent, not the person reading. */
function withoutIds(text: string): string {
  return text.replace(/\s*[([]?\bid=[\w-]+[)\]]?/g, '').replace(/\s+—\s*$/, '');
}

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] | null = null;
  let list: Extract<Block, { kind: 'list' }> | null = null;
  // A blank line between list items keeps the list ("1. …", blank, "2. …" is still one list); anything else ends it.
  let blank = false;
  const close = () => { paragraph = null; list = null; };

  for (const raw of withoutIds(text).replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) { paragraph = null; blank = true; continue; }
    const afterBlank = blank;
    blank = false;
    const heading = raw.match(HEADING)?.[1] ?? raw.match(BOLD_LINE)?.[1];
    if (heading && !MAIL_LINK.test(heading)) { close(); blocks.push({ kind: 'heading', text: heading.trim() }); continue; }
    MAIL_LINK.lastIndex = 0;
    const bullet = raw.match(BULLET)?.[1];
    const numberedMatch = bullet === undefined ? raw.match(NUMBERED) : null;
    const numbered = numberedMatch?.[2];
    const item = bullet ?? numbered;
    if (item !== undefined) {
      const ordered = numbered !== undefined;
      if (!list || list.ordered !== ordered) { paragraph = null; list = { kind: 'list', ordered, items: [] }; blocks.push(list); }
      // The number the model wrote is kept, so a "3." that follows a paragraph still reads 3.
      list.items.push({ text: item, sub: [], number: numberedMatch ? Number(numberedMatch[1]) : undefined });
      continue;
    }
    if (list && SUB_LINE.test(raw)) { list.items[list.items.length - 1].sub.push(raw.trim()); continue; }
    if (afterBlank) list = null;
    list = null;
    if (!paragraph) { paragraph = []; blocks.push({ kind: 'paragraph', lines: paragraph }); }
    paragraph.push(raw.trim());
  }
  return blocks;
}

/** Mail links become buttons that open the mail; without a handler only the subject is shown. */
function withMailLinks(text: string, onOpenMail: OpenMail | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MAIL_LINK)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    let id = match[2];
    try { id = decodeURIComponent(id); } catch { /* keep it as written */ }
    out.push(onOpenMail
      ? <button key={`${key}-${start}`} type="button" className="md-mail-link" title="Abrir este correo" onClick={() => onOpenMail(id)}>{match[1]}</button>
      : match[1]);
    last = start + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** **bold**, *italic*, `code` and links to mails. */
export function inlineMarkdown(line: string, onOpenMail?: OpenMail): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).flatMap((part, index): ReactNode[] => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return [<strong key={index}>{withMailLinks(part.slice(2, -2), onOpenMail, `${index}`)}</strong>];
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return [<code key={index}>{part.slice(1, -1)}</code>];
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return [<em key={index}>{withMailLinks(part.slice(1, -1), onOpenMail, `${index}`)}</em>];
    return withMailLinks(part, onOpenMail, `${index}`);
  });
}

export function MessageText({ text, onOpenMail }: { text: string; onOpenMail?: OpenMail }) {
  const inline = (line: string) => inlineMarkdown(line, onOpenMail);
  return (
    <div className="message-text md">
      {parse(text).map((block, index) => {
        if (block.kind === 'heading') return <p key={index} className="md-heading">{inline(block.text)}</p>;
        if (block.kind === 'paragraph') return (
          <p key={index}>{block.lines.map((line, i) => <span key={i}>{i > 0 && <br />}{inline(line)}</span>)}</p>
        );
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List key={index}>
            {block.items.map((item, i) => (
              <li key={i} value={block.ordered ? item.number : undefined}>
                <span>{inline(item.text)}</span>
                {item.sub.map((sub, j) => <span key={j} className="md-sub">{inline(sub)}</span>)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
