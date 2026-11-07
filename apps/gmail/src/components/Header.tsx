import { Mail, RefreshCw, ShieldAlert } from 'lucide-react';
import { MAIL, ACCOUNT } from '../services/platform';
interface HeaderProps {pendingCount:number;totalEmails:number;unreadCount:number;onRefresh:()=>void;refreshing?:boolean;updatedAt?:Date|null;isGmailConnected:boolean;onOpenGmailAuth:()=>void;onOpenSettings:()=>void;onOpenPending:()=>void;authorizing?:boolean;center?:import('react').ReactNode}
export function Header(p:HeaderProps){
  return <header className="workspace-topbar">
    <div className="workspace-brand"><img src="./nexomail.svg" width="34" height="34" alt=""/><strong>NexoMail</strong><span className="workspace-provider">{MAIL.toUpperCase()}</span></div>
    <button type="button" className={`workspace-connection ${p.isGmailConnected?'connected':''}`} onClick={p.onOpenGmailAuth} disabled={p.authorizing} aria-busy={p.authorizing} title={p.isGmailConnected?`Gestionar cuenta de ${MAIL}`:`Conectar con ${ACCOUNT}`}><span className="connection-dot"/><Mail size={14}/>{p.authorizing?'Conectando…':p.isGmailConnected?`${MAIL} real`:window.emailAgentHost.pageAccount?`Conectar ${MAIL}`:'Demostración'}</button>
    <div className="workspace-topbar-actions"><span className="workspace-mail-count">{p.totalEmails} correos · {p.unreadCount} sin leer</span>{p.center}{p.pendingCount>0 && <button type="button" className="workspace-pending-count" onClick={p.onOpenPending} title="Propuestas del asistente que esperan tu aprobación. Nada se ejecuta hasta que las apruebes."><ShieldAlert aria-hidden="true"/><span className="lbl-long">{p.pendingCount===1?'1 acción por aprobar':`${p.pendingCount} acciones por aprobar`}</span><span className="lbl-short">{p.pendingCount} por aprobar</span></button>}
      <button type="button" className="workspace-icon" onClick={p.onRefresh} disabled={p.refreshing} aria-busy={p.refreshing} aria-label="Sincronizar correos" title={p.refreshing?'Sincronizando correos…':`Sincronizar correos: vuelve a traer los más recientes de ${MAIL}${p.updatedAt?` (última vez: ${p.updatedAt.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})})`:''}`}><RefreshCw size={17} className={p.refreshing?'spin':''}/></button>
      {(p.refreshing || p.updatedAt) && <span className="workspace-sync-note" role="status" aria-live="polite">{p.refreshing?'Sincronizando…':`Actualizado ${p.updatedAt!.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`}</span>}
      <button type="button" className="workspace-button" onClick={p.onOpenSettings}>Configuración</button>
    </div>
  </header>;
}
