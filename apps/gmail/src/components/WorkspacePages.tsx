import { useEffect, useState } from 'react';
import { LayoutDashboard, Settings, Mail, ShieldCheck, History, AlertTriangle, Sun, Moon, RefreshCw, Database, Lock, KeyRound, ExternalLink } from 'lucide-react';
import type { Email } from '../types/email';
import { fetchLlmHealth, type LlmHealth } from '../services/llmClient';
import { mailProvider } from '../services/mailProvider';
import { openPrivacyPolicy } from './PrivacyConsent';
import { MAIL, ACCOUNT, PLATFORM } from '../services/platform';
interface Props {view:'summary'|'settings';emails:Email[];pendingCount:number;logCount:number;theme:'dark'|'light';strictMode:boolean;onToggleTheme:()=>void;onToggleStrictMode:()=>void;onAuthorize:()=>void;connected:boolean;storageStatus:string;storageReady:boolean;onEraseStorage:()=>void}
/** Microsoft only accepts sign-ins that return to an address registered as a single-page application. */
function MicrosoftRedirect(){
  const [status,setStatus]=useState('');
  const redirect=window.emailAgentHost.microsoftRedirect();
  async function copy(){try{await navigator.clipboard.writeText(redirect);setStatus('Dirección copiada. Añádela como SPA en Microsoft Entra.');}catch{setStatus('No se pudo copiar. Selecciona la dirección y cópiala.');}}
  return <div className="st-row st-col"><div className="st-text"><strong>Dirección de retorno de esta extensión</strong><small>Debe estar registrada como «Aplicación de página única (SPA)» en la aplicación {window.emailAgentHost.config.microsoftClientId} de Microsoft Entra.</small></div>
    <input className="st-input" readOnly value={redirect} onFocus={e=>e.currentTarget.select()} aria-label="Dirección de retorno de esta extensión"/>
    <div className="st-inline"><button type="button" className="pa-btn pa-btn-secondary" onClick={copy}>Copiar dirección</button><a href="https://entra.microsoft.com/" target="_blank" rel="noopener noreferrer" className="pa-btn pa-btn-ghost">Abrir Microsoft Entra<ExternalLink aria-hidden="true"/></a><small role="status">{status}</small></div>
  </div>;
}
export function WorkspacePages(p:Props){
  const [health,setHealth]=useState<LlmHealth|null>(null);
  const [loading,setLoading]=useState(false);
  useEffect(()=>{let active=true;if(p.view==='settings'){setLoading(true);fetchLlmHealth().then(value=>{if(active){setHealth(value);setLoading(false);}});}return()=>{active=false;};},[p.view]);
  async function refresh(){setLoading(true);try{setHealth(await fetchLlmHealth());}finally{setLoading(false);}}
  if(p.view==='summary')return <section className="workspace-page workspace-scroll"><div className="workspace-section-heading"><LayoutDashboard size={21}/><h2>Resumen general</h2></div><div className="workspace-page-body"><p className="workspace-muted">Estado de los correos cargados y de las acciones de esta sesión.</p><div className="workspace-stats">
    {[{icon:Mail,label:'Correos cargados',value:p.emails.length},{icon:Mail,label:'Sin leer',value:p.emails.filter(e=>!e.read).length},{icon:AlertTriangle,label:'Requieren aprobación',value:p.pendingCount},{icon:History,label:'Eventos de auditoría',value:p.logCount}].map((stat,index)=><article key={index} className="workspace-card workspace-stat"><stat.icon size={22}/><div><span>{stat.label}</span><strong>{stat.value}</strong></div></article>)}
    </div><article className="workspace-card"><h3>Tu espacio de trabajo</h3><p>Consulta tus mensajes en la bandeja, prepara respuestas con el agente y revisa sus propuestas en Acciones pendientes.</p><p className="workspace-muted">Estos indicadores corresponden a los mensajes cargados. No representan todo tu buzón.</p></article></div></section>;
  return <section className="workspace-page workspace-scroll page-narrow"><div className="workspace-section-heading"><Settings size={21}/><h2>Ajustes</h2></div><p className="pa-intro">Tu cuenta, cómo trabaja el asistente y los datos que guarda.</p><div className="st-list">
    <section className="st-group" aria-labelledby="st-account"><h3 id="st-account">Cuenta de {MAIL}</h3>
      <div className="st-row"><span className="st-icon" aria-hidden="true"><Mail/></span><div className="st-text"><strong>{p.connected?(mailProvider.accountEmail() || 'Cuenta autorizada'):'Sin conectar'}</strong><small>{p.connected?'NexoMail lee y gestiona este buzón con tu aprobación.':'Autoriza tu cuenta para trabajar con tus correos reales.'}</small></div><button type="button" className="pa-btn pa-btn-secondary" onClick={p.onAuthorize}>{p.connected?'Gestionar':'Conectar'}</button></div>
      {PLATFORM==='outlook' && <MicrosoftRedirect/>}
    </section>
    <section className="st-group" aria-labelledby="st-prefs"><h3 id="st-prefs">Preferencias</h3>
      <div className="st-row"><div className="st-text"><strong>Apariencia</strong><small>Se aplica al panel y a la pantalla completa.</small></div><div className="st-segmented" role="group" aria-label="Apariencia">{(['light','dark'] as const).map(value=><button key={value} type="button" aria-pressed={p.theme===value} onClick={()=>{if(p.theme!==value)p.onToggleTheme();}}>{value==='light'?<Sun aria-hidden="true"/>:<Moon aria-hidden="true"/>}{value==='light'?'Claro':'Oscuro'}</button>)}</div></div>
      <label className="st-row st-clickable"><div className="st-text"><strong>Revisión estricta</strong><small>También pide aprobación para etiquetar correos.</small></div><input type="checkbox" role="switch" className="st-switch" checked={p.strictMode} onChange={p.onToggleStrictMode}/></label>
      <div className="st-row st-info"><span className="st-icon" aria-hidden="true"><ShieldCheck/></span><div className="st-text"><small>Enviar correos y moverlos a la papelera siempre requieren tu aprobación, con o sin revisión estricta.</small></div></div>
    </section>
    <section className="st-group" aria-labelledby="st-ai"><h3 id="st-ai">Asistente de IA</h3>
      <dl className="st-facts"><div><dt>Proveedor</dt><dd>{loading?'Consultando…':health?.provider || 'No disponible'}</dd></div><div><dt>Modelo</dt><dd>{health?.model || 'Sin información'}</dd></div><div><dt>Estado</dt><dd><span className={`st-dot ${health?.configured?'ok':''}`} aria-hidden="true"/>{health?.configured?'Configurado':'Sin confirmar'}</dd></div></dl>
      <div className="st-row st-actions"><small>Consultar el estado no genera ninguna respuesta de IA. La conexión se comparte con {PLATFORM==='outlook'?'Gmail':'Outlook'}.</small><div><button type="button" className="pa-btn pa-btn-ghost" disabled={loading} onClick={refresh}><RefreshCw aria-hidden="true"/>{loading?'Actualizando…':'Actualizar'}</button><button type="button" className="pa-btn pa-btn-secondary" onClick={()=>window.emailAgentHost.openOptions()}>Opciones de la extensión</button></div></div>
    </section>
    <section className="st-group" aria-labelledby="st-data"><h3 id="st-data">Datos guardados</h3>
      <div className="st-row"><span className="st-icon" aria-hidden="true"><Database/></span><div className="st-text"><strong>{p.storageStatus}</strong><small>El chat, los borradores y el historial pueden contener datos personales. Revisa el estado antes de cerrar.</small></div>{p.storageReady && <button type="button" className="pa-btn pa-btn-danger-ghost" onClick={p.onEraseStorage}>Vaciar datos</button>}</div>
    </section>
    <section className="st-group" aria-labelledby="st-privacy"><h3 id="st-privacy">Privacidad y permisos</h3>
      <div className="st-row"><span className="st-icon" aria-hidden="true"><Lock/></span><div className="st-text"><strong>Política de privacidad</strong><small>Qué datos se leen, dónde se guardan y con quién se comparten.</small></div><button type="button" className="pa-btn pa-btn-secondary" onClick={openPrivacyPolicy}>Leer</button></div>
      <div className="st-row"><span className="st-icon" aria-hidden="true"><KeyRound/></span><div className="st-text"><strong>Permisos concedidos a {ACCOUNT}</strong><small>Leer, etiquetar, mover a la papelera y recuperar correos; enviar los que apruebes. No puede borrar de forma definitiva.</small></div><a className="pa-btn pa-btn-secondary" href={PLATFORM==='outlook'?'https://account.live.com/consent/Manage':'https://myaccount.google.com/connections'} target="_blank" rel="noopener noreferrer">Revisar o retirar<ExternalLink aria-hidden="true"/></a></div>
      <div className="st-row st-info"><span className="st-icon" aria-hidden="true"><ShieldCheck/></span><div className="st-text"><small>Los adjuntos del chat solo salen en el correo que apruebes, y la IA ve únicamente sus nombres.</small></div></div>
    </section>
    <section className="st-group" aria-labelledby="st-about"><h3 id="st-about">Acerca de NexoMail</h3>
      <div className="st-row"><div className="st-text"><strong>Proyecto de tesis de Marlon Aguiño y Jonathan Pérez</strong><small>Con PostgreSQL conectado se guardan el chat, los borradores y el historial de cada cuenta. Las propuestas pendientes no se ejecutan al recargar. Los mensajes reales se consultan mediante la API de {MAIL}.</small></div></div>
    </section>
  </div></section>;
}
