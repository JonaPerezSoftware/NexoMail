import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Paperclip, Send, X } from 'lucide-react';
import type { MailFile } from '../types/email';
import { MAX_ATTACHMENT_BYTES } from '../services/mailProvider';
import { MAX_ATTACHMENT_LABEL } from '../services/platform';

export interface ComposeValue { to: string; subject: string; body: string; files: MailFile[]; draftId?: string }

interface Props {
  value: ComposeValue | null;
  onClose: () => void;
  /** Creates a proposal in Acciones; nothing is sent until it is approved. */
  onSubmit: (value: ComposeValue) => void;
  onSaveDraft: (value: ComposeValue) => void;
}

const validAddress = (value: string) => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value.trim());
const formatSize = (bytes: number) => bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

/** New message, reply or saved draft. Same flow as Outlook: write, then approve in Acciones. */
export function ComposeModal({ value, onClose, onSubmit, onSaveDraft }: Props) {
  const [draft, setDraft] = useState<ComposeValue | null>(value);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value); setError(''); if (value) setTimeout(() => firstField.current?.focus(), 0); }, [value]);
  useEffect(() => {
    if (!value) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [value, onClose]);
  if (!draft) return null;
  const set = (patch: Partial<ComposeValue>) => setDraft(prev => prev ? { ...prev, ...patch } : prev);

  const addFiles = async (list: FileList | null) => {
    setError('');
    const picked = [...(list ?? [])];
    const total = draft.files.reduce((s, f) => s + f.size, 0) + picked.reduce((s, f) => s + f.size, 0);
    if (total > MAX_ATTACHMENT_BYTES) { setError(`Los adjuntos superan ${MAX_ATTACHMENT_LABEL} en total.`); return; }
    try {
      const read = await Promise.all(picked.map(file => new Promise<MailFile>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(file.name));
        reader.onload = () => resolve({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: String(reader.result).split(',')[1] ?? '' });
        reader.readAsDataURL(file);
      })));
      set({ files: [...draft.files, ...read] });
    } catch (e) { setError(`No se pudo leer ${e instanceof Error ? e.message : 'el archivo'}.`); }
    finally { if (fileInput.current) fileInput.current.value = ''; }
  };

  const submit = () => {
    if (!validAddress(draft.to)) { setError('Escribe una dirección de correo válida en «Para».'); return; }
    if (!draft.body.trim()) { setError('Escribe el mensaje antes de prepararlo.'); return; }
    onSubmit({ ...draft, to: draft.to.trim(), subject: draft.subject.trim() || '(Sin asunto)' });
  };

  return (
    <div className="pc-backdrop" role="presentation">
      <section className="cm-dialog" role="dialog" aria-modal="true" aria-labelledby="cm-title">
        <header className="cm-head">
          <h2 id="cm-title">{draft.subject.toLowerCase().startsWith('re:') ? 'Responder' : 'Nuevo correo'}</h2>
          <button type="button" className="cm-close" onClick={onClose} aria-label="Cerrar sin enviar"><X aria-hidden="true" /></button>
        </header>
        <div className="pa-form">
          <label htmlFor="cm-to">Para</label>
          <input ref={firstField} id="cm-to" type="email" value={draft.to} onChange={e => set({ to: e.target.value })} placeholder="nombre@dominio.com" />
          <label htmlFor="cm-subject">Asunto</label>
          <input id="cm-subject" type="text" value={draft.subject} onChange={e => set({ subject: e.target.value })} />
          <label htmlFor="cm-body">Mensaje</label>
          <textarea id="cm-body" rows={10} value={draft.body} onChange={e => set({ body: e.target.value })} />
        </div>
        {draft.files.length > 0 && (
          <ul className="pa-files" aria-label="Adjuntos">
            {draft.files.map((file, index) => (
              <li key={index}>
                {file.type.startsWith('image/') ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
                <span>{file.name}</span><small>{formatSize(file.size)}</small>
                <button type="button" className="cm-remove" onClick={() => set({ files: draft.files.filter((_, i) => i !== index) })} aria-label={`Quitar ${file.name}`}><X aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="cm-error" role="alert">{error}</p>}
        <p className="pa-note">Se creará una propuesta en Acciones. El correo solo se envía cuando la apruebes.</p>
        <footer className="pa-actions">
          <input ref={fileInput} type="file" multiple hidden onChange={e => void addFiles(e.target.files)} />
          <button type="button" className="pa-btn pa-btn-ghost pa-edit" onClick={() => fileInput.current?.click()}><Paperclip aria-hidden="true" />Adjuntar</button>
          <button type="button" className="pa-btn pa-btn-secondary" onClick={() => onSaveDraft(draft)}>Guardar borrador</button>
          <button type="button" className="pa-btn pa-btn-primary" onClick={submit}><Send aria-hidden="true" />Preparar envío</button>
        </footer>
      </section>
    </div>
  );
}
