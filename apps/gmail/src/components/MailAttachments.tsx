import { useEffect, useState } from 'react';
import { Download, Eye, FileText, Image as ImageIcon, Loader2, Paperclip, ShieldAlert, X } from 'lucide-react';
import type { Email, MailAttachment } from '../types/email';
import { formatSize } from '../services/mailFiles';

/** Only bitmap images are shown inside the app; SVG and HTML could run code and are only downloaded. */
const PREVIEWABLE = /^image\/(?:jpeg|png|gif|webp|bmp)$/i;
/** Files that can run code or hide it (programs, scripts, Office macros, disk images). */
const DANGEROUS = /\.(?:exe|msi|bat|cmd|com|scr|pif|cpl|js|jse|vbs|vbe|wsf|ps1|psm1|jar|hta|lnk|reg|iso|img|vhdx?|dll|docm|xlsm|pptm|dotm|xlam|apk|app|dmg|sh)$/i;
const ARCHIVE = /\.(?:zip|rar|7z|gz|tar|cab)$/i;
const LARGE_BYTES = 15 * 1024 * 1024;

/** Downloaded files are kept for the session, so viewing then saving costs one download. */
const cache = new Map<string, Blob>();
const cacheKey = (email: Email, attachment: MailAttachment) => `${email.id}:${attachment.id}`;

interface Props {
  email: Email;
  /** True when the message has risk signals: downloads ask for confirmation first. */
  risky: boolean;
  onList: (email: Email) => Promise<MailAttachment[]>;
  onDownload: (email: Email, attachment: MailAttachment) => Promise<Blob>;
}

export function MailAttachments({ email, risky, onList, onDownload }: Props) {
  const [items, setItems] = useState<MailAttachment[] | null>(email.attachments ?? null);
  const [listError, setListError] = useState('');
  const [working, setWorking] = useState<{ id: string; what: 'view' | 'save' } | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);

  // Outlook lists attachments only when a message that has them is opened.
  useEffect(() => {
    let active = true;
    setError(''); setListError('');
    if (email.attachments) { setItems(email.attachments); return; }
    if (!email.hasAttachments) { setItems([]); return; }
    setItems(null);
    onList(email).then((list) => { if (active) setItems(list); })
      .catch((reason) => { if (active) { setItems([]); setListError(reason instanceof Error ? reason.message : 'No se pudieron leer los adjuntos.'); } });
    return () => { active = false; };
  // Keyed by message: marking it as read must not list its attachments again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id, email.hasAttachments, onList]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  if (items === null) return <div className="att-box" role="status"><Loader2 aria-hidden="true" className="spin" />Buscando adjuntos…</div>;
  if (!items.length && !listError) return null;

  async function blobOf(attachment: MailAttachment): Promise<Blob> {
    const key = cacheKey(email, attachment);
    const known = cache.get(key);
    if (known) return known;
    const blob = await onDownload(email, attachment);
    cache.set(key, blob);
    return blob;
  }

  async function run(attachment: MailAttachment, what: 'view' | 'save') {
    if (working) return;
    if (what === 'save') {
      const warnings = [
        DANGEROUS.test(attachment.name) ? 'Este tipo de archivo puede ejecutar programas en tu equipo. Ábrelo solo si confías en el remitente y lo esperabas.' : '',
        risky ? 'Este correo tiene señales de riesgo.' : '',
        attachment.size > LARGE_BYTES ? `El archivo pesa ${formatSize(attachment.size)} y puede tardar en descargarse.` : '',
      ].filter(Boolean);
      if (warnings.length && !confirm(`${warnings.join('\n\n')}\n\n¿Descargar «${attachment.name}»?`)) return;
    }
    setWorking({ id: attachment.id, what }); setError('');
    try {
      const blob = await blobOf(attachment);
      const url = URL.createObjectURL(blob);
      if (what === 'view') { setPreview({ name: attachment.name, url }); return; }
      const link = document.createElement('a');
      link.href = url; link.download = attachment.name.replace(/[\\/:*?"<>|]/g, '_'); link.rel = 'noopener';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo descargar el adjunto.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <section className="att-box" aria-label="Archivos adjuntos">
      <h3 className="att-title"><Paperclip aria-hidden="true" />{items.length === 1 ? '1 adjunto' : `${items.length} adjuntos`}</h3>
      {listError && <p className="att-error" role="alert">{listError}</p>}
      <ul className="att-list">
        {items.map((attachment) => {
          const image = PREVIEWABLE.test(attachment.type);
          const dangerous = DANGEROUS.test(attachment.name);
          const busy = working?.id === attachment.id;
          return (
            <li key={attachment.id} className={`att-item${dangerous ? ' att-danger' : ''}`}>
              <span className="att-icon" aria-hidden="true">{dangerous ? <ShieldAlert /> : image ? <ImageIcon /> : <FileText />}</span>
              <span className="att-text">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small>
                  {attachment.size ? formatSize(attachment.size) : 'Tamaño desconocido'}
                  {dangerous && ' · Puede ejecutar programas'}
                  {!dangerous && ARCHIVE.test(attachment.name) && ' · Archivo comprimido: revisa su contenido'}
                  {attachment.unsupported && ' · Elemento de Outlook, no descargable'}
                </small>
              </span>
              {image && !attachment.unsupported && (
                <button type="button" className="pa-btn pa-btn-ghost att-btn" disabled={!!working} onClick={() => void run(attachment, 'view')}>
                  {busy && working?.what === 'view' ? <Loader2 aria-hidden="true" className="spin" /> : <Eye aria-hidden="true" />}{busy && working?.what === 'view' ? 'Abriendo…' : 'Ver'}
                </button>
              )}
              {!attachment.unsupported && (
                <button type="button" className="pa-btn pa-btn-secondary att-btn" disabled={!!working} onClick={() => void run(attachment, 'save')}>
                  {busy && working?.what === 'save' ? <Loader2 aria-hidden="true" className="spin" /> : <Download aria-hidden="true" />}{busy && working?.what === 'save' ? 'Descargando…' : 'Descargar'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="att-error" role="alert">{error}</p>}
      <p className="att-note">Los adjuntos se descargan solo cuando lo pides. NexoMail nunca los abre ni los ejecuta.</p>
      {preview && (
        <div className="att-viewer" role="dialog" aria-modal="true" aria-label={preview.name} onClick={() => setPreview(null)}>
          <div className="att-viewer-bar" onClick={(event) => event.stopPropagation()}>
            <strong>{preview.name}</strong>
            <button type="button" className="cm-close" onClick={() => setPreview(null)} aria-label="Cerrar"><X aria-hidden="true" /></button>
          </div>
          <img src={preview.url} alt={preview.name} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </section>
  );
}
