import { useEffect, useRef } from 'react';
import { ShieldCheck } from 'lucide-react';

/** Raising this version asks everyone to accept the policy again before connecting an account. */
const POLICY_VERSION = '1';
const POLICY_KEY = 'nexomail.privacy.accepted';
export const PRIVACY_POLICY_URL = '../../privacy.html';

export function privacyAccepted(): boolean {
  try { return localStorage.getItem(POLICY_KEY) === POLICY_VERSION; } catch { return false; }
}

function rememberAcceptance(): void {
  try { localStorage.setItem(POLICY_KEY, POLICY_VERSION); } catch { /* the notice will show again next time */ }
}

export function openPrivacyPolicy(): void {
  window.open(PRIVACY_POLICY_URL, '_blank', 'noopener');
}

interface Props { open: boolean; provider: string; onAccept: () => void; onCancel: () => void }

/** Shown once before the first account connection: what NexoMail reads, where it keeps it, and who else sees it. */
export function PrivacyConsent({ open, provider, onAccept, onCancel }: Props) {
  const accept = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    accept.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="pc-backdrop" role="presentation">
      <section className="pc-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-title">
        <span className="pc-icon" aria-hidden="true"><ShieldCheck /></span>
        <h2 id="pc-title">Antes de conectar {provider}</h2>
        <ul>
          <li>NexoMail leerá tus correos para mostrarlos, analizarlos y preparar acciones. <strong>Nada se envía, borra ni mueve sin tu aprobación.</strong></li>
          <li>El chat, los borradores y el historial se guardan en la base de datos de <strong>tu equipo</strong>.</li>
          <li>Si usas la IA con Gemini, tu petición y un extracto de los correos se envían a Google.</li>
          <li>Puedes retirar el acceso y borrar tus datos cuando quieras desde Ajustes.</li>
        </ul>
        <button type="button" className="pc-link" onClick={openPrivacyPolicy}>Leer la política de privacidad completa</button>
        <div className="pc-actions">
          <button type="button" className="pa-btn pa-btn-secondary" onClick={onCancel}>Ahora no</button>
          <button ref={accept} type="button" className="pa-btn pa-btn-primary" onClick={() => { rememberAcceptance(); onAccept(); }}>Aceptar y continuar</button>
        </div>
      </section>
    </div>
  );
}
