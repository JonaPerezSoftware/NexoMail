import { Mail, RefreshCw } from 'lucide-react';
import { MAIL, ACCOUNT } from '../services/platform';
interface HeaderProps {pendingCount:number;totalEmails:number;unreadCount:number;onRefresh:()=>void;isGmailConnected:boolean;onOpenGmailAuth:()=>void;onOpenSettings:()=>void;authorizing?:boolean}
export function Header(p:HeaderProps){
  return <header className="workspace-topbar">
    <div className="workspace-brand"><img src="./nexomail.svg" width="34" height="34" alt=""/><strong>NexoMail</strong><span className="workspace-provider">{MAIL.toUpperCase()}</span></div>
    <button type="button" className={`workspace-connection ${p.isGmailConnected?'connected':''}`} onClick={p.onOpenGmailAuth} disabled={p.authorizing} aria-busy={p.authorizing} title={p.isGmailConnected?`Gestionar cuenta de ${MAIL}`:`Conectar con ${ACCOUNT}`}><span className="connection-dot"/><Mail size={14}/>{p.authorizing?'Conectando…':p.isGmailConnected?`${MAIL} real`:window.emailAgentHost.pageAccount?`Conectar ${MAIL}`:'Demostración'}</button>
    <div className="workspace-topbar-actions"><span className="workspace-mail-count">{p.totalEmails} correos · {p.unreadCount} sin leer</span>{p.pendingCount>0 && <span className="workspace-pending-count">{p.pendingCount} pendientes</span>}
      <button type="button" className="workspace-icon" onClick={p.onRefresh} aria-label="Sincronizar correos" title="Sincronizar correos"><RefreshCw size={17}/></button>
      <button type="button" className="workspace-button" onClick={p.onOpenSettings}>Configuración</button>
    </div>
  </header>;
}
