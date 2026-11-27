import { useEffect, useRef } from 'react';
import { ShieldCheck } from 'lucide-react';

/** Raising this version changes the text people accept; every connection asks again anyway. */
export const POLICY_VERSION = '2';
const LOG_KEY = 'nexomail.privacy.log';
export const PRIVACY_POLICY_URL = '../../privacy.html';

/** One accepted notice: which mailbox, which account was then connected, which policy version, and when. */
export interface ConsentRecord { provider: string; email: string; version: string; acceptedAt: string }

export function consentHistory(): ConsentRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.acceptedAt === 'string') : [];
  } catch { return []; }
}

/** Kept in this browser only, after the connection it was accepted for succeeds. */
export function recordConsent(provider: string, email: string): void {
  try {
    const record: ConsentRecord = { provider, email, version: POLICY_VERSION, acceptedAt: new Date().toISOString() };
    localStorage.setItem(LOG_KEY, JSON.stringify([record, ...consentHistory()].slice(0, 20)));
  } catch { /* the connection still works; only the local record is missing */ }
}

export function openPrivacyPolicy(): void {
  window.open(PRIVACY_POLICY_URL, '_blank', 'noopener');
}

interface Props { open: boolean; provider: string; onAccept: () => void; onCancel: () => void }

/**
 * Shown every time an account is connected (also after disconnecting it): what NexoMail reads,
 * where it keeps it, and who else sees it. Nothing is authorized until the person accepts.
 */
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
          <li>Inicias sesión en la página de {provider}: <strong>NexoMail nunca ve tu contraseña.</strong></li>
          <li>El chat, los borradores y el historial se guardan <strong>solo en tu equipo</strong>: en tu base de datos si la configuraste o, si no, solo mientras la sesión está abierta.</li>
          <li>Si usas una IA en la nube (Claude o Gemini), tu petición y un extracto de los correos se envían a Anthropic o a Google. Con Ollama, todo queda en tu equipo.</li>
          <li>Puedes retirar el acceso y borrar tus datos cuando quieras desde Ajustes.</li>
        </ul>
        <button type="button" className="pc-link" onClick={openPrivacyPolicy}>Leer la política de privacidad completa</button>
        <p className="pc-note">Se pide cada vez que conectas una cuenta. La aceptación se registra con la fecha y la cuenta en Ajustes.</p>
        <div className="pc-actions">
          <button type="button" className="pa-btn pa-btn-secondary" onClick={onCancel}>Ahora no</button>
          <button ref={accept} type="button" className="pa-btn pa-btn-primary" onClick={onAccept}>Aceptar y continuar</button>
        </div>
      </section>
    </div>
  );
}
