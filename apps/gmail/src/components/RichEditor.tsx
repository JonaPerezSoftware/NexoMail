import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, Baseline, Bold, Highlighter, Image as ImageIcon, IndentDecrease, IndentIncrease,
  Italic, Link2, List, ListOrdered, Quote, Redo2, RemoveFormatting, Smile, Strikethrough, Underline, Undo2, X,
} from 'lucide-react';
import { normalizeUrl } from '../services/mailLinks';
import { readMailFile } from '../services/mailFiles';
import { linksInHtml, sanitizeHtml } from '../services/richText';
import { LinkSummary } from './BodyEditor';

/**
 * The message editor, like Gmail's: what you see is what is sent. Formatting is applied by the browser's editing
 * commands; whatever the editor holds is sanitized before it is shown elsewhere or sent (see richText.ts).
 */

const SIZES = [{ label: 'Pequeño', value: '2' }, { label: 'Normal', value: '3' }, { label: 'Grande', value: '5' }, { label: 'Enorme', value: '6' }];
const COLORS = ['#202124', '#5f6368', '#d93025', '#e37400', '#f9ab00', '#188038', '#1a73e8', '#7627bb', '#c5221f', '#ffffff'];
const HIGHLIGHTS = ['transparent', '#fff475', '#ccff90', '#a7ffeb', '#cbf0f8', '#aecbfa', '#d7aefb', '#fdcfe8', '#f28b82', '#e8eaed'];
const EMOJIS = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😎', '🤓', '🧐', '🤔', '🤗', '🤝', '👍', '👎', '👏', '🙌', '🙏', '💪', '👋', '✌️', '👌', '🤞', '☝️', '👉', '👀', '🎉', '🎊', '🎂', '🎁', '🏆', '⭐', '🌟', '✨', '🔥', '💯', '✅', '☑️', '❌', '⚠️', '❗', '❓', '💡', '📌', '📎', '📅', '📆', '⏰', '⌛', '📧', '📨', '📩', '📝', '📄', '📊', '📈', '💼', '🏢', '💻', '📱', '☎️', '💰', '💳', '🧾', '🛒', '🚀', '✈️', '🚗', '🏠', '☕', '🍕', '❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '🙁', '😢', '😭', '😮', '😴', '😬', '🤦', '🤷', '🎓', '📚', '🌎', '☀️', '🌧️', '🎵'];

interface Props {
  id: string;
  /** HTML of the message. */
  value: string;
  onChange: (html: string) => void;
  /** Taller editor for the full-screen window. */
  minHeight?: number;
  /** The signature editor has no images (they would have to travel with every message). */
  allowImages?: boolean;
  placeholder?: string;
  label?: string;
}

type Popover = 'color' | 'highlight' | 'emoji' | 'size' | null;

export function RichEditor({ id, value, onChange, minHeight = 200, allowImages = true, placeholder = 'Escribe tu mensaje…', label = 'Mensaje' }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const savedRange = useRef<Range | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [popover, setPopover] = useState<Popover>(null);
  const [linkForm, setLinkForm] = useState<{ text: string; url: string; hadSelection: boolean } | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState<Record<string, boolean>>({});

  // The editor is only rewritten when the value comes from outside (opening a draft, a signature), never while typing.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || value === lastEmitted.current) return;
    el.innerHTML = sanitizeHtml(value);
    lastEmitted.current = value;
  }, [value]);

  const emit = () => {
    const html = area.current?.innerHTML ?? '';
    lastEmitted.current = html;
    onChange(html);
  };

  // Which buttons are «on» (bold, list…) follows the cursor.
  useEffect(() => {
    const update = () => {
      if (!area.current || !area.current.contains(document.getSelection()?.anchorNode ?? null)) return;
      const state: Record<string, boolean> = {};
      for (const command of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight']) {
        try { state[command] = document.queryCommandState(command); } catch { state[command] = false; }
      }
      setActive(state);
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  useEffect(() => {
    if (!popover) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest?.('.re-pop, .re-pop-trigger')) setPopover(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setPopover(null); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey, true); };
  }, [popover]);

  const saveSelection = () => {
    const selection = document.getSelection();
    if (selection && selection.rangeCount && area.current?.contains(selection.anchorNode)) savedRange.current = selection.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    area.current?.focus();
    const selection = document.getSelection();
    if (savedRange.current && selection) { selection.removeAllRanges(); selection.addRange(savedRange.current); }
  };
  /** Runs one editing command where the cursor was (buttons take the focus away, so the selection is restored first). */
  const run = (command: string, argument?: string, css = false) => {
    restoreSelection();
    try { document.execCommand('styleWithCSS', false, css ? 'true' : 'false'); } catch { /* older engines */ }
    document.execCommand(command, false, argument);
    saveSelection();
    emit();
  };
  const insertHtml = (html: string) => {
    restoreSelection();
    document.execCommand('insertHTML', false, html);
    saveSelection();
    emit();
  };

  const addImages = async (files: File[]) => {
    setError('');
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        const read = await readMailFile(file);
        insertHtml(`<img src="data:${read.type};base64,${read.data}" alt="${file.name.replace(/[<>"&]/g, '')}">`);
      } catch { setError(`No se pudo leer la imagen ${file.name}.`); }
    }
  };

  const openLink = () => {
    saveSelection();
    const text = savedRange.current?.toString() ?? '';
    setLinkForm({ text, url: '', hadSelection: !!text });
    setError('');
  };
  const applyLink = () => {
    if (!linkForm) return;
    const url = normalizeUrl(linkForm.url);
    if (!url) { setError('Escribe una dirección web completa, por ejemplo https://www.ejemplo.com/pagina'); return; }
    const text = (linkForm.text || url).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
    if (linkForm.hadSelection && linkForm.text === savedRange.current?.toString()) run('createLink', url);
    else insertHtml(`<a href="${url.replace(/"/g, '%22')}">${text}</a>&nbsp;`);
    setLinkForm(null);
  };

  const button = (command: string, Icon: typeof Bold, title: string, argument?: string, css = false) => (
    <button type="button" className={`re-btn${active[command] ? ' on' : ''}`} title={title} aria-label={title} aria-pressed={active[command] ?? undefined}
      onMouseDown={(event) => event.preventDefault()} onClick={() => run(command, argument, css)}><Icon aria-hidden="true" /></button>
  );
  const togglePopover = (which: Exclude<Popover, null>) => { saveSelection(); setPopover((current) => (current === which ? null : which)); };

  return (
    <div className="re">
      <div className="re-toolbar" role="toolbar" aria-label="Formato del mensaje" aria-controls={id}>
        {button('undo', Undo2, 'Deshacer (Ctrl + Z)')}
        {button('redo', Redo2, 'Rehacer (Ctrl + Y)')}
        <span className="re-sep" aria-hidden="true" />
        <div className="re-group">
          <button type="button" className="re-btn re-size re-pop-trigger" aria-haspopup="menu" aria-expanded={popover === 'size'} title="Tamaño del texto" onMouseDown={(event) => event.preventDefault()} onClick={() => togglePopover('size')}>Aa</button>
          {popover === 'size' && <div className="re-pop re-pop-menu" role="menu">{SIZES.map((size) => (
            <button key={size.value} type="button" role="menuitem" className={`re-size-${size.value}`} onMouseDown={(event) => event.preventDefault()} onClick={() => { setPopover(null); run('fontSize', size.value); }}>{size.label}</button>
          ))}</div>}
        </div>
        {button('bold', Bold, 'Negrita (Ctrl + B)')}
        {button('italic', Italic, 'Cursiva (Ctrl + I)')}
        {button('underline', Underline, 'Subrayado (Ctrl + U)')}
        {button('strikeThrough', Strikethrough, 'Tachado')}
        <div className="re-group">
          <button type="button" className="re-btn re-pop-trigger" aria-haspopup="dialog" aria-expanded={popover === 'color'} title="Color del texto" aria-label="Color del texto" onMouseDown={(event) => event.preventDefault()} onClick={() => togglePopover('color')}><Baseline aria-hidden="true" /></button>
          {popover === 'color' && <div className="re-pop re-swatches" role="dialog" aria-label="Color del texto">{COLORS.map((color) => (
            <button key={color} type="button" className="re-swatch" style={{ background: color }} title={color} aria-label={`Color ${color}`} onMouseDown={(event) => event.preventDefault()} onClick={() => { setPopover(null); run('foreColor', color, true); }} />
          ))}</div>}
        </div>
        <div className="re-group">
          <button type="button" className="re-btn re-pop-trigger" aria-haspopup="dialog" aria-expanded={popover === 'highlight'} title="Color de resaltado" aria-label="Color de resaltado" onMouseDown={(event) => event.preventDefault()} onClick={() => togglePopover('highlight')}><Highlighter aria-hidden="true" /></button>
          {popover === 'highlight' && <div className="re-pop re-swatches" role="dialog" aria-label="Color de resaltado">{HIGHLIGHTS.map((color) => (
            <button key={color} type="button" className={`re-swatch${color === 'transparent' ? ' none' : ''}`} style={{ background: color === 'transparent' ? undefined : color }} title={color === 'transparent' ? 'Sin resaltado' : color} aria-label={color === 'transparent' ? 'Sin resaltado' : `Resaltado ${color}`} onMouseDown={(event) => event.preventDefault()} onClick={() => { setPopover(null); run('hiliteColor', color, true); }} />
          ))}</div>}
        </div>
        <span className="re-sep" aria-hidden="true" />
        {button('justifyLeft', AlignLeft, 'Alinear a la izquierda')}
        {button('justifyCenter', AlignCenter, 'Centrar')}
        {button('justifyRight', AlignRight, 'Alinear a la derecha')}
        {button('insertUnorderedList', List, 'Lista con viñetas')}
        {button('insertOrderedList', ListOrdered, 'Lista numerada')}
        {button('outdent', IndentDecrease, 'Reducir sangría')}
        {button('indent', IndentIncrease, 'Aumentar sangría')}
        {button('formatBlock', Quote, 'Cita', 'blockquote')}
        <span className="re-sep" aria-hidden="true" />
        <button type="button" className="re-btn" title="Insertar enlace (Ctrl + K)" aria-label="Insertar enlace" onMouseDown={(event) => event.preventDefault()} onClick={openLink}><Link2 aria-hidden="true" /></button>
        {allowImages && <>
          <button type="button" className="re-btn" title="Insertar imagen en el texto" aria-label="Insertar imagen en el texto" onMouseDown={(event) => event.preventDefault()} onClick={() => { saveSelection(); imageInput.current?.click(); }}><ImageIcon aria-hidden="true" /></button>
          <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { void addImages([...(event.target.files ?? [])]); event.target.value = ''; }} />
        </>}
        <div className="re-group">
          <button type="button" className="re-btn re-pop-trigger" aria-haspopup="dialog" aria-expanded={popover === 'emoji'} title="Emojis" aria-label="Insertar emoji" onMouseDown={(event) => event.preventDefault()} onClick={() => togglePopover('emoji')}><Smile aria-hidden="true" /></button>
          {popover === 'emoji' && <div className="re-pop re-emojis" role="dialog" aria-label="Emojis">{EMOJIS.map((emoji) => (
            <button key={emoji} type="button" aria-label={emoji} onMouseDown={(event) => event.preventDefault()} onClick={() => { restoreSelection(); document.execCommand('insertText', false, emoji); saveSelection(); emit(); }}>{emoji}</button>
          ))}</div>}
        </div>
        {button('removeFormat', RemoveFormatting, 'Quitar formato')}
      </div>

      <div
        ref={area}
        id={id}
        className="re-area"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-placeholder={placeholder}
        style={{ minHeight }}
        onInput={emit}
        onBlur={saveSelection}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openLink(); } }}
        onPaste={(event) => {
          const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
          if (images.length && allowImages) { event.preventDefault(); saveSelection(); void addImages(images); return; }
          const html = event.clipboardData.getData('text/html');
          if (html) { event.preventDefault(); saveSelection(); insertHtml(sanitizeHtml(html)); }
        }}
        onDrop={(event) => {
          const images = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
          if (!images.length) return;
          event.preventDefault();
          if (!allowImages) return;
          saveSelection();
          void addImages(images);
        }}
        suppressContentEditableWarning
      />

      {linkForm && (
        <div className="be-form" role="group" aria-label="Insertar enlace">
          <label>Texto que se verá<input autoFocus value={linkForm.text} onChange={(event) => setLinkForm({ ...linkForm, text: event.target.value })} placeholder="Por ejemplo: www.mibanco.com o «aquí»" /></label>
          <label>Dirección a la que lleva<input value={linkForm.url} onChange={(event) => { setLinkForm({ ...linkForm, url: event.target.value }); setError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyLink(); } }} placeholder="https://www.ejemplo.com/pagina" /></label>
          {error && <p className="cm-error" role="alert">{error}</p>}
          <div className="be-form-actions">
            <button type="button" className="pa-btn pa-btn-ghost" onClick={() => setLinkForm(null)}><X aria-hidden="true" />Cancelar</button>
            <button type="button" className="pa-btn pa-btn-primary" onClick={applyLink}><Link2 aria-hidden="true" />Insertar</button>
          </div>
        </div>
      )}
      {!linkForm && error && <p className="cm-error" role="alert">{error}</p>}
      <LinkSummary links={linksInHtml(value)} />
    </div>
  );
}
