import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Maximize2, Minimize2, Minus, Paperclip, Send, X } from 'lucide-react';
import type { MailFile } from '../types/email';
import { MAX_ATTACHMENT_BYTES } from '../services/mailProvider';
import { MAX_ATTACHMENT_LABEL } from '../services/platform';
import { formatSize, readMailFile } from '../services/mailFiles';
import { addressList, extractInlineImages, hasFormatting, htmlToText, sanitizeHtml, validAddress } from '../services/richText';
import { RichEditor } from './RichEditor';
import { RecipientField } from './RecipientField';

export interface ComposeValue {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** Plain-text copy (what the AI and the checks read). */
  body: string;
  /** What the editor holds: formatted HTML. When it opens, an empty value starts from body. */
  bodyHtml?: string;
  /** Attachments; images inside the text are added as inline files when the message is prepared. */
  files: MailFile[];
  draftId?: string;
  /** Sender of the message being answered. */
  replyToSender?: string;
}

interface Props {
  value: ComposeValue | null;
  onClose: () => void;
  /** Creates a proposal in Acciones; nothing is sent until it is approved. */
  onSubmit: (value: ComposeValue) => void;
  onSaveDraft: (value: ComposeValue) => void;
}

type Size = 'normal' | 'max' | 'min';

/** New message, reply or saved draft, like Gmail's compose window. Same flow as before: write, then approve in Acciones. */
export function ComposeModal({ value, onClose, onSubmit, onSaveDraft }: Props) {
  const [draft, setDraft] = useState<ComposeValue | null>(value);
  const [error, setError] = useState('');
  const [size, setSize] = useState<Size>('normal');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(value); setError(''); setSize('normal');
    setShowCc(!!value?.cc); setShowBcc(!!value?.bcc);
    if (value) setTimeout(() => firstField.current?.focus(), 0);
  }, [value]);
  useEffect(() => {
    if (!value) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && size !== 'min') { if (size === 'max') setSize('normal'); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [value, onClose, size]);
  if (!draft) return null;
  const set = (patch: Partial<ComposeValue>) => setDraft(prev => prev ? { ...prev, ...patch } : prev);
  const html = draft.bodyHtml ?? '';
  const regularFiles = draft.files.filter(file => !file.inline);

  const addFiles = async (list: FileList | null) => {
    setError('');
    const picked = [...(list ?? [])];
    try {
      const read = await Promise.all(picked.map(readMailFile));
      if (draft.files.reduce((s, f) => s + f.size, 0) + read.reduce((s, f) => s + f.size, 0) > MAX_ATTACHMENT_BYTES) { setError(`Los adjuntos superan ${MAX_ATTACHMENT_LABEL} en total.`); return; }
      set({ files: [...draft.files, ...read] });
    } catch (e) { setError(`No se pudo leer ${e instanceof Error ? e.message : 'el archivo'}.`); }
    finally { if (fileInput.current) fileInput.current.value = ''; }
  };

  /** The editor's HTML, cleaned, with its images as inline attachments; and the plain-text copy. */
  const finish = (): ComposeValue => {
    const clean = sanitizeHtml(html);
    const { html: withCids, images } = extractInlineImages(clean);
    const text = htmlToText(clean);
    return {
      ...draft,
      to: draft.to.trim().replace(/[,;\s]+$/, ''), cc: (draft.cc ?? '').trim().replace(/[,;\s]+$/, ''), bcc: (draft.bcc ?? '').trim().replace(/[,;\s]+$/, ''),
      body: text,
      // Plain messages stay plain text (as before); anything with formatting, links or images goes as HTML.
      bodyHtml: hasFormatting(clean) ? withCids : undefined,
      files: [...regularFiles, ...(hasFormatting(clean) ? images : [])],
    };
  };

  const submit = () => {
    const value = finish();
    const fields: [string, string][] = [['Para', value.to], ['Cc', value.cc ?? ''], ['Cco', value.bcc ?? '']];
    if (!addressList(value.to).length) { setError('Escribe al menos una dirección en «Para».'); return; }
    for (const [name, field] of fields) {
      const bad = addressList(field).find(address => !validAddress(address));
      if (bad) { setError(`«${bad}» en ${name} no es una dirección de correo válida.`); return; }
    }
    if (!value.body.replace(/\[imagen\]/g, '').trim() && !value.files.some(f => f.inline)) { setError('Escribe el mensaje antes de prepararlo.'); return; }
    if (value.files.reduce((s, f) => s + f.size, 0) > MAX_ATTACHMENT_BYTES) { setError(`Los adjuntos y las imágenes superan ${MAX_ATTACHMENT_LABEL} en total.`); return; }
    onSubmit({ ...value, subject: value.subject.trim() || '(Sin asunto)' });
  };

  const title = draft.subject.trim() || (draft.subject.toLowerCase().startsWith('re:') ? 'Responder' : 'Nuevo correo');
  const heading = draft.subject.toLowerCase().startsWith('re:') ? 'Responder' : 'Nuevo correo';

  if (size === 'min') {
    return (
      <div className="cm-minibar" role="region" aria-label="Correo en redacción minimizado">
        <button type="button" className="cm-minibar-title" onClick={() => setSize('normal')} title="Volver a abrir">{title}</button>
        <button type="button" className="cm-close" onClick={() => setSize('normal')} aria-label="Restaurar"><Maximize2 aria-hidden="true" /></button>
        <button type="button" className="cm-close" onClick={onClose} aria-label="Cerrar sin enviar"><X aria-hidden="true" /></button>
      </div>
    );
  }

  return (
    <div className={`pc-backdrop${size === 'max' ? ' cm-backdrop-max' : ''}`} role="presentation">
      <section className={`cm-dialog cm-compose${size === 'max' ? ' cm-max' : ''}`} role="dialog" aria-modal="true" aria-labelledby="cm-title">
        <header className="cm-head">
          <h2 id="cm-title">{heading}</h2>
          <div className="cm-window">
            <button type="button" className="cm-close" onClick={() => setSize('min')} aria-label="Minimizar" title="Minimizar"><Minus aria-hidden="true" /></button>
            <button type="button" className="cm-close" onClick={() => setSize(size === 'max' ? 'normal' : 'max')} aria-label={size === 'max' ? 'Salir de pantalla completa' : 'Pantalla completa'} title={size === 'max' ? 'Salir de pantalla completa' : 'Pantalla completa'}>
              {size === 'max' ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            <button type="button" className="cm-close" onClick={onClose} aria-label="Cerrar sin enviar" title="Cerrar sin enviar"><X aria-hidden="true" /></button>
          </div>
        </header>
        <div className="pa-form cm-fields">
          <RecipientField id="cm-to" label="Para" value={draft.to} onChange={to => set({ to })} inputRef={firstField}
            trailing={<span className="cm-cc-toggles">
              {!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}
              {!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Cco</button>}
            </span>} />
          {showCc && <RecipientField id="cm-cc" label="Cc" value={draft.cc ?? ''} onChange={cc => set({ cc })} autoFocus={!draft.cc} />}
          {showBcc && <RecipientField id="cm-bcc" label="Cco" value={draft.bcc ?? ''} onChange={bcc => set({ bcc })} autoFocus={!draft.bcc} />}
          <label htmlFor="cm-subject">Asunto</label>
          <input id="cm-subject" type="text" value={draft.subject} onChange={e => set({ subject: e.target.value })} />
          <RichEditor id="cm-body" value={html} onChange={bodyHtml => set({ bodyHtml })} minHeight={size === 'max' ? 360 : 200} />
        </div>
        {regularFiles.length > 0 && (
          <ul className="pa-files" aria-label="Adjuntos">
            {regularFiles.map(file => (
              <li key={file.name + file.size}>
                {file.type.startsWith('image/') ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
                <span>{file.name}</span><small>{file.originalSize ? <span title="Foto reducida para enviarla más rápido">{formatSize(file.originalSize)} → {formatSize(file.size)}</span> : formatSize(file.size)}</small>
                <button type="button" className="cm-remove" onClick={() => set({ files: draft.files.filter(f => f !== file) })} aria-label={`Quitar ${file.name}`}><X aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="cm-error" role="alert">{error}</p>}
        <p className="pa-note">Se creará una propuesta en Acciones. El correo solo se envía cuando la apruebes.</p>
        <footer className="pa-actions">
          <input ref={fileInput} type="file" multiple hidden onChange={e => void addFiles(e.target.files)} />
          <button type="button" className="pa-btn pa-btn-ghost pa-edit" onClick={() => fileInput.current?.click()}><Paperclip aria-hidden="true" />Adjuntar</button>
          <button type="button" className="pa-btn pa-btn-secondary" onClick={() => onSaveDraft(finish())}>Guardar borrador</button>
          <button type="button" className="pa-btn pa-btn-primary" onClick={submit}><Send aria-hidden="true" />Preparar envío</button>
        </footer>
      </section>
    </div>
  );
}
