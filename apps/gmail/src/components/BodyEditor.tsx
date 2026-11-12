import { useRef, useState } from 'react';
import { AlertTriangle, Link2, X } from 'lucide-react';
import { checkLink } from '@shared/mail/mail-insights';
import { insertLink, linksIn, normalizeUrl } from '../services/mailLinks';

/** Where each link of a message really goes, with a warning when its text shows another site. */
export function LinkSummary({ body }: { body: string }) {
  const links = linksIn(body);
  if (!links.length) return null;
  return (
    <ul className="be-links" aria-label="Enlaces de este correo">
      {links.map((link, index) => {
        const check = checkLink(link.href, link.text);
        const warnings = check.findings.filter(f => f.weight > 0);
        return (
          <li key={index} className={warnings.length ? 'be-link-warn' : ''}>
            {warnings.length ? <AlertTriangle aria-hidden="true" /> : <Link2 aria-hidden="true" />}
            <span><strong>«{link.text}»</strong> → {check.domain || link.href}
              {warnings.map(w => <small key={w.reason}>{w.reason}</small>)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

interface Props { id: string; value: string; onChange: (value: string) => void; rows?: number }

/** Message text with an «Insertar enlace» button: the visible text and the real address are chosen separately. */
export function BodyEditor({ id, value, onChange, rows = 10 }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState<{ text: string; url: string; start: number; end: number } | null>(null);
  const [error, setError] = useState('');

  function open() {
    const el = area.current;
    const start = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? value.length;
    setForm({ text: value.slice(start, end), url: '', start, end });
    setError('');
  }
  function apply() {
    if (!form) return;
    const url = normalizeUrl(form.url);
    if (!url) { setError('Escribe una dirección web completa, por ejemplo https://www.ejemplo.com/pagina'); return; }
    const next = insertLink(value, form.start, form.end, form.text || url, url);
    onChange(next.body);
    setForm(null);
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(next.cursor, next.cursor); });
  }

  return (
    <div className="be">
      <textarea ref={area} id={id} rows={rows} value={value} onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); } }} />
      <div className="be-tools">
        <button type="button" className="pa-btn pa-btn-ghost" onClick={open} title="Insertar enlace (Ctrl + K)"><Link2 aria-hidden="true" />Insertar enlace</button>
        <small>Selecciona un texto y pulsa «Insertar enlace» (o Ctrl + K) para que ese texto lleve a otra dirección.</small>
      </div>
      {form && (
        <div className="be-form" role="group" aria-label="Insertar enlace">
          <label>Texto que se verá<input autoFocus value={form.text} onChange={e => setForm({ ...form, text: e.target.value })} placeholder="Por ejemplo: www.mibanco.com o «aquí»" /></label>
          <label>Dirección a la que lleva<input value={form.url} onChange={e => { setForm({ ...form, url: e.target.value }); setError(''); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }} placeholder="https://…" /></label>
          {error && <p className="cm-error" role="alert">{error}</p>}
          <div className="be-form-actions">
            <button type="button" className="pa-btn pa-btn-ghost" onClick={() => setForm(null)}><X aria-hidden="true" />Cancelar</button>
            <button type="button" className="pa-btn pa-btn-primary" onClick={apply}><Link2 aria-hidden="true" />Insertar</button>
          </div>
        </div>
      )}
      <LinkSummary body={value} />
    </div>
  );
}
