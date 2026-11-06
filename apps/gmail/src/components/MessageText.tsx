import type { ReactNode } from 'react';

/**
 * Renders the agent's answers (AI or local rules) as readable blocks: headings, bulleted and
 * numbered lists with a secondary line, and paragraphs. Everything becomes React nodes, so the
 * text is never treated as HTML.
 */

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; items: { text: string; sub: string[] }[] }
  | { kind: 'paragraph'; lines: string[] };

const BULLET = /^\s{0,3}(?:[•\-*·])\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,2}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,4}\s+(.*)$/;
/** A whole line in bold, such as "**Resumen de tu bandeja**", reads as a title. */
const BOLD_LINE = /^\s*\*\*([^*]+)\*\*:?\s*$/;
const SUB_LINE = /^\s{2,}\S/;

/** Internal identifiers help the agent, not the person reading. */
function withoutIds(text: string): string {
  return text.replace(/\s*[([]?\bid=[\w-]+[)\]]?/g, '').replace(/\s+—\s*$/, '');
}

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] | null = null;
  let list: Extract<Block, { kind: 'list' }> | null = null;
  const close = () => { paragraph = null; list = null; };

  for (const raw of withoutIds(text).replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) { close(); continue; }
    const heading = raw.match(HEADING)?.[1] ?? raw.match(BOLD_LINE)?.[1];
    if (heading) { close(); blocks.push({ kind: 'heading', text: heading.trim() }); continue; }
    const bullet = raw.match(BULLET)?.[1];
    const numbered = bullet === undefined ? raw.match(NUMBERED)?.[1] : undefined;
    const item = bullet ?? numbered;
    if (item !== undefined) {
      const ordered = numbered !== undefined;
      if (!list || list.ordered !== ordered) { paragraph = null; list = { kind: 'list', ordered, items: [] }; blocks.push(list); }
      list.items.push({ text: item, sub: [] });
      continue;
    }
    if (list && SUB_LINE.test(raw)) { list.items[list.items.length - 1].sub.push(raw.trim()); continue; }
    list = null;
    if (!paragraph) { paragraph = []; blocks.push({ kind: 'paragraph', lines: paragraph }); }
    paragraph.push(raw.trim());
  }
  return blocks;
}

/** **bold**, *italic* and `code`. */
export function inlineMarkdown(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function MessageText({ text }: { text: string }) {
  return (
    <div className="message-text md">
      {parse(text).map((block, index) => {
        if (block.kind === 'heading') return <p key={index} className="md-heading">{inlineMarkdown(block.text)}</p>;
        if (block.kind === 'paragraph') return (
          <p key={index}>{block.lines.map((line, i) => <span key={i}>{i > 0 && <br />}{inlineMarkdown(line)}</span>)}</p>
        );
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List key={index}>
            {block.items.map((item, i) => (
              <li key={i}>
                <span>{inlineMarkdown(item.text)}</span>
                {item.sub.map((sub, j) => <span key={j} className="md-sub">{inlineMarkdown(sub)}</span>)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
