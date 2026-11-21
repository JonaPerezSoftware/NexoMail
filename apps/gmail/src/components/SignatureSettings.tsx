import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { mailProvider } from '../services/mailProvider';
import { loadSignature, saveSignature } from '../services/signature';
import { RichEditor } from './RichEditor';

/** Ajustes → Firma: added at the end of every new message and reply of this account (it can be deleted in each one). */
export function SignatureSettings() {
  const account = mailProvider.accountEmail();
  const [html, setHtml] = useState(() => loadSignature(account));
  const [saved, setSaved] = useState(true);
  useEffect(() => { setHtml(loadSignature(account)); setSaved(true); }, [account]);
  return (
    <>
      <div className="st-row st-model"><div className="st-text"><strong>Firma</strong><small>Se añade al final de cada correo nuevo y de cada respuesta de {account || 'esta cuenta'}; puedes borrarla en cada uno. Se guarda en este navegador. Admite formato y enlaces, no imágenes.</small></div></div>
      <div className="st-signature">
        <RichEditor id="st-signature" value={html} onChange={(value) => { setHtml(value); setSaved(false); }} minHeight={90} allowImages={false} placeholder="Por ejemplo: tu nombre, cargo y teléfono" label="Firma" />
        <div className="st-signature-actions">
          {saved ? <small className="st-saved"><Check aria-hidden="true" />{html.replace(/<[^>]+>|&nbsp;|\s/g, '') ? 'Firma guardada' : 'Sin firma'}</small> : <small>Cambios sin guardar</small>}
          <button type="button" className="pa-btn pa-btn-primary" disabled={saved} onClick={() => { saveSignature(account, html); setSaved(true); }}>Guardar firma</button>
        </div>
      </div>
    </>
  );
}
