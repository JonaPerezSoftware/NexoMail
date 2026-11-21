import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * NexoMail's own confirmation. The browser's window.confirm is unreliable here: the app runs in a frame inside
 * Gmail or Outlook, where Chrome can hide or skip those dialogs, so an action could run without being confirmed.
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  items?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** A notice: a single button, no choice to make. */
  notice?: boolean;
}

type Request = ConfirmOptions & { resolve: (ok: boolean) => void };
let show: ((request: Request) => void) | null = null;

/** Replaces window.alert: the first paragraph is the title, the rest the explanation. */
export function notify(text: string): Promise<boolean> {
  const [title, ...rest] = text.split('\n\n');
  return askConfirm({ title, message: rest.join('\n\n') || undefined, confirmLabel: 'Entendido', notice: true });
}

/** Resolves true only when the person presses the confirm button. Without the host mounted, it answers false. */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => { if (show) show({ ...options, resolve }); else resolve(false); });
}

export function ConfirmHost() {
  const [request, setRequest] = useState<Request | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    show = next => setRequest(current => { current?.resolve(false); return next; });
    return () => { show = null; };
  }, []);
  useEffect(() => {
    if (!request) return;
    // Dangerous choices start on «Cancelar», so pressing Enter by habit never confirms them.
    (request.danger ? cancelRef : confirmRef).current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const close = (ok: boolean) => { setRequest(current => { current?.resolve(ok); return null; }); };
  if (!request) return null;
  return <div className="pc-backdrop nx-confirm-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(false); }}>
    <section className={`cm-dialog nx-confirm${request.danger ? ' danger' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="nx-confirm-title" aria-describedby="nx-confirm-body">
      <h2 id="nx-confirm-title">{request.danger && <AlertTriangle aria-hidden="true" />}{request.title}</h2>
      <div id="nx-confirm-body">
        {request.items && request.items.length > 0 && <ul>{request.items.map(item => <li key={item}>{item}</li>)}</ul>}
        {request.message && request.message.split('\n\n').map((part, index) => <p key={index}>{part}</p>)}
      </div>
      <footer>
        {!request.notice && <button ref={cancelRef} type="button" className="pa-btn pa-btn-secondary" onClick={() => close(false)}>{request.cancelLabel ?? 'Cancelar'}</button>}
        <button ref={confirmRef} type="button" className={`pa-btn ${request.danger ? 'pa-btn-danger' : 'pa-btn-primary'}`} onClick={() => close(true)}>{request.confirmLabel ?? 'Aceptar'}</button>
      </footer>
    </section>
  </div>;
}
