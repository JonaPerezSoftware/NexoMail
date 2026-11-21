import { useEffect, useState } from 'react';
import { Mail, MailCheck, Search, Trash2, ShieldCheck, ArrowLeft, RefreshCw, Undo2, Tag, Folder, PenSquare, Reply, Sparkles, MoreHorizontal, FileText, Pencil, Loader2, ShieldAlert, ExternalLink } from 'lucide-react';
import {MailDocument} from './MailDocument';
import { MailSafety } from './MailSafety';
import { MANUAL_CATEGORIES, type Email, type MailAttachment } from '../types/email';
import type { StoredDraft } from '@shared/storage/workspace-storage';
import { MAIL, PLATFORM } from '../services/platform';
import { BusyButton } from './BusyButton';
import { MailAttachments } from './MailAttachments';
import { isInlineImage, loadInlineImages } from '../services/inlineImages';
import { mailProvider } from '../services/mailProvider';

/** The same message in Gmail or Outlook on the web: Gmail by conversation (and the right account), Outlook by its own link. */
function openInProviderUrl(email:Email):string|null{
  if(PLATFORM==='outlook')return email.webLink && /^https:\/\/[\w.-]+\.(?:office|outlook|live|office365|microsoft)\.com\//i.test(email.webLink)?email.webLink:null;
  const id=email.threadId || email.id;
  if(!/^[0-9a-f]{8,32}$/i.test(id))return null;
  const account=mailProvider.accountEmail();
  return `https://mail.google.com/mail/${account?`?authuser=${encodeURIComponent(account)}`:'u/0/'}#all/${id}`;
}
import { askConfirm } from './ConfirmDialog';
import { mailWhen, messageStamp } from '../services/dates';

/** List: "Hoy 10:53", "Ayer 21:39", "5 nov 09:50". Reader: the full date and time. */
const listWhen=(email:Email)=>{const w=mailWhen(email.timestamp);return w?w.charAt(0).toUpperCase()+w.slice(1):email.date;};
/** Same question from the button and from «Más»: what moves, where to, and how to undo it. */
const confirmSpam=(email:Email)=>askConfirm({title:'¿Reportar como spam?',message:`«${email.subject || '(Sin asunto)'}» de ${email.sender} se moverá a No deseado. ${MAIL} lo tratará como spam y aprenderá a filtrar correos parecidos.\n\nPodrás recuperarlo desde No deseado con «No es spam».`,confirmLabel:'Mover a No deseado',danger:true});
const fullWhen=(email:Email)=>email.timestamp&&!isNaN(new Date(email.timestamp).getTime())?messageStamp(new Date(email.timestamp)):email.date;

export type MailFolder = 'inbox' | 'sent' | 'drafts' | 'starred' | 'all' | 'spam' | 'trash';
export const MAIL_FOLDERS: { id: MailFolder; name: string }[] = [
  { id: 'inbox', name: 'Entrada' },
  { id: 'sent', name: 'Enviados' },
  { id: 'drafts', name: 'Borradores guardados' },
  { id: 'starred', name: 'Destacados' },
  { id: 'all', name: 'Todos los correos' },
  { id: 'spam', name: 'No deseado' },
  { id: 'trash', name: 'Papelera' },
];

interface Props {
  updatedAt?:string;automatic:boolean;onAutomaticChange:(enabled:boolean)=>void;emails:Email[];onMarkRead:(id:string)=>void|Promise<void>;onTrash:(ids:string[])=>void|Promise<void>;
  selectedCategory:string;onSelectCategory:(category:string)=>void;
  folder:MailFolder;onSelectFolder:(folder:MailFolder)=>void;folderEmails:Email[]|null;folderLoading:boolean;onRefresh:()=>void;refreshing:boolean;
  drafts:StoredDraft[];onOpenDraft:(draft:StoredDraft)=>void;onDiscardDraft:(id:string)=>void;
  onCompose:(prefill?:{to:string;subject:string;replyToSender?:string})=>void;onReplyWithAI:(email:Email)=>void;
  onRestore:(ids:string[])=>Promise<void>;
  /** Spam folder: back to the inbox, and the provider learns it was not spam. */
  onNotSpam:(ids:string[])=>Promise<void>;
  /** Reports a message as spam and moves it to No deseado. */
  onMarkSpam:(ids:string[])=>Promise<void>;onSetCategory:(email:Email,category:string|null)=>Promise<void>;
  loadLimit:number;maxLoaded:number;onLoadMore:()=>void;loadingMore:boolean;connected:boolean;
  /** A mail to open, asked for from the chat. The nonce lets the same mail be opened twice. */
  focus?:{id:string;nonce:number}|null;
  onListAttachments:(email:Email)=>Promise<MailAttachment[]>;
  /** Asks the assistant to draft a verification message to the real organization. */
  onVerifyByOtherChannel?:(email:Email)=>void;
  onAttachmentFindings?:(email:Email,findings:import('@shared/mail/attachment-scan').AttachmentFinding[])=>void;onDownloadAttachment:(email:Email,attachment:MailAttachment)=>Promise<Blob>;
}
const categories=['Todos','Sin leer','Trabajo','Personal','Importante','Finanzas','Boletines','Sin clasificar','Con alertas'];

const initial=(name:string)=>(name.trim().replace(/^["'(<]+/,'').charAt(0) || '?').toUpperCase();
/** Gmail labels set by hand win over automatic grouping. In the demo they are plain label names. */
const manualOf=(email:Email)=>email.manualCategories ?? email.labels.filter(label=>(MANUAL_CATEGORIES as readonly string[]).includes(label));

export function EmailInbox(p:Props){
  const {emails,onMarkRead,onTrash,selectedCategory,onSelectCategory,automatic,onAutomaticChange,folder}=p;
  const [query,setQuery]=useState('');
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  /** Which reader action is running, to show its own label ("Recuperando…", "Guardando…"). */
  const [busyWhat,setBusyWhat]=useState('');
  useEffect(()=>{
    if(!p.focus)return;
    setQuery('');setSelectedId(p.focus.id);
    if(emails.some(email=>email.id===p.focus?.id && !email.read))void onMarkRead(p.focus.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[p.focus]);
  const inTrash=folder==='trash',inSent=folder==='sent',inDrafts=folder==='drafts',inSpam=folder==='spam';
  const source=folder==='inbox'?emails:(p.folderEmails ?? []);
  const loading=folder!=='inbox' && !inDrafts && p.folderLoading && !p.folderEmails;
  const selected=source.find(email=>email.id===selectedId);
  // Images that are part of the message (cid:) are downloaded from the mailbox and shown inside the text.
  const [inlineImages,setInlineImages]=useState<Record<string,string>>({});
  useEffect(()=>{
    setInlineImages({});
    if(!selected || !/\bcid:/i.test(selected.bodyHtml ?? ''))return;
    let active=true;
    void loadInlineImages(selected,p.onListAttachments,p.onDownloadAttachment).then(images=>{if(active)setInlineImages(images);}).catch(()=>{});
    return()=>{active=false;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selected?.id,selected?.bodyHtml]);
  const webUrl=selected && p.connected ? openInProviderUrl(selected) : null;
  const folderName=MAIL_FOLDERS.find(f=>f.id===folder)?.name ?? 'Correo';

  const labelsOf=(email:Email)=>{const manual=manualOf(email);return manual.length?manual:automatic?(email.insights?.categories || []):[email.category];};
  const filtered=source.filter(email=>{
    const labels=labelsOf(email);
    const matches=selectedCategory==='Todos' || (selectedCategory==='Sin leer'?!email.read:selectedCategory==='Con alertas'?email.insights?.level!=='none':selectedCategory==='Sin clasificar'?labels.length===0 || (labels.length===1 && labels[0]==='Sin clasificar'):labels.some(label=>label===selectedCategory));
    return matches && `${email.subject} ${email.senderName} ${email.sender} ${email.recipient} ${email.snippet} ${email.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  const count=(category:string)=>category==='Todos'?source.length:category==='Sin leer'?source.filter(e=>!e.read).length:category==='Con alertas'?source.filter(e=>e.insights && e.insights.level!=='none').length:null;
  const subtitle=inDrafts?`${p.drafts.length} guardado${p.drafts.length===1?'':'s'} · sin enviar`
    :inTrash?(loading?'cargando…':`${source.length} correo${source.length===1?'':'s'} · se eliminan solos a los 30 días`)
    :inSpam?(loading?'cargando…':`${source.length===1?'1 correo marcado':`${source.length} correos marcados`} como no deseado por ${MAIL}`)
    :loading?'cargando…':`${source.length} cargado${source.length===1?'':'s'}${folder==='inbox' && p.updatedAt?` · actualizado ${p.updatedAt}`:''}${folder==='all'?' · sin No deseado ni Papelera':''}`;
  function clearFilters(){setQuery('');onSelectCategory('Todos');}
  async function run(task:()=>Promise<void>|void,what=''){if(busy)return;setBusy(true);setBusyWhat(what);try{await task();}finally{setBusy(false);setBusyWhat('');}}
  const who=(email:Email)=>inSent?`Para: ${email.recipient}`:email.senderName;

  return <div className={`gmail-inbox mx-inbox ${selected?'reader-open':''}`}>
    <div className="ox-mailhead">
      <div className="mx-title"><h2>{folderName}</h2><span>{subtitle}</span></div>
      {/* Search and grouping share the title row, so the list and the reader get the height. Sync lives in the top bar. */}
      {!inDrafts && <><label className="mx-search"><Search aria-hidden="true"/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Buscar por asunto, remitente o contenido" aria-label="Buscar en correos"/></label>
        {!inTrash && <label className="mx-toggle" title={`Reglas locales. No cambia las etiquetas de ${MAIL}. Se revisa cada 60 s con la vista activa. Las clasificaciones manuales siempre se respetan.`}>
          <input type="checkbox" role="switch" className="st-switch" checked={automatic} onChange={e=>onAutomaticChange(e.target.checked)}/>
          <span>Agrupar automáticamente</span>
        </label>}</>}
      <label className="ox-location"><span className="visually-hidden">Carpeta</span><Folder aria-hidden="true"/>
        <select aria-label="Carpeta" value={folder} onChange={event=>{setSelectedId(null);p.onSelectFolder(event.target.value as MailFolder);}}>
          {MAIL_FOLDERS.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      <button type="button" className="pa-btn pa-btn-primary ox-compose" onClick={()=>p.onCompose()}><PenSquare aria-hidden="true"/>Nuevo correo</button>
    </div>

    {inDrafts ? <div className="mx-drafts">
      {p.drafts.length===0
        ? <div className="pa-empty"><FileText aria-hidden="true"/><h3>No hay borradores guardados</h3><p>Escribe un correo y elige «Guardar borrador» para retomarlo después.</p><button type="button" className="pa-btn pa-btn-primary" onClick={()=>p.onCompose()}><PenSquare aria-hidden="true"/>Nuevo correo</button></div>
        : <ul className="mx-draft-list">{p.drafts.map(draft=><li key={draft.id} className="mx-draft">
            <span className="mx-avatar" aria-hidden="true"><FileText/></span>
            <div className="mx-draft-body"><strong>{draft.subject || '(Sin asunto)'}</strong><span>Para: {draft.to || 'pendiente de destinatario'}</span><p>{draft.body || 'Todavía no has escrito el mensaje.'}</p>{draft.attachments_omitted && <small>Tenía adjuntos que no se conservaron; vuelve a añadirlos.</small>}</div>
            <div className="mx-draft-actions"><button type="button" className="pa-btn pa-btn-secondary" onClick={()=>p.onOpenDraft(draft)}><Pencil aria-hidden="true"/>Continuar</button><button type="button" className="pa-btn pa-btn-danger-ghost" onClick={async()=>{if(await askConfirm({title:'¿Descartar este borrador?',message:'No se enviará ningún correo.',confirmLabel:'Descartar',danger:true}))p.onDiscardDraft(draft.id);}}>Descartar</button></div>
          </li>)}</ul>}
    </div> : <>
    <div className="gmail-inbox-toolbar mx-toolbar ox-filters">
      <nav className="mx-chips" aria-label="Filtrar correos">{categories.map(category=>{const n=count(category);return <button type="button" key={category} className="mx-chip" onClick={()=>{setSelectedId(null);onSelectCategory(category);}} aria-pressed={selectedCategory===category}>{category}{n!==null && <span>{n}</span>}</button>;})}</nav>
    </div>

    <div className="gmail-reader-split">
      <div className="gmail-message-list mx-list" aria-label={`Correos de ${folderName}`} aria-busy={loading}>
        {loading
          ? <div className="pa-empty" role="status"><RefreshCw aria-hidden="true"/><h3>Cargando {folderName.toLowerCase()}…</h3></div>
          : filtered.length===0
          ? <div className="pa-empty"><Mail aria-hidden="true"/><h3>{source.length===0?(inTrash?'La papelera está vacía':inSpam?'No hay correo no deseado':'No hay mensajes aquí'):'Sin coincidencias'}</h3><p>{source.length===0?(inTrash?'Los correos que muevas a la papelera aparecerán aquí durante 30 días.':'Esta carpeta no tiene mensajes cargados. Sincroniza para actualizarla.'):'Prueba otra búsqueda o quita los filtros.'}</p>{source.length>0 && <button type="button" className="pa-btn pa-btn-secondary" onClick={clearFilters}><RefreshCw aria-hidden="true"/>Limpiar filtros</button>}</div>
          : filtered.map(email=>{
            const category=labelsOf(email)[0];
            const manual=manualOf(email).length>0;
            const risky=email.insights && email.insights.level!=='none';
            return <button type="button" key={email.id} className={`mx-item ${email.read?'':'unread'} ${selectedId===email.id?'active':''}`} onClick={()=>{setSelectedId(email.id);if(!email.read && !inTrash)onMarkRead(email.id);}} aria-pressed={selectedId===email.id}>
              <span className="mx-avatar" aria-hidden="true">{initial(inSent?email.recipient:email.senderName)}</span>
              <span className="mx-item-body">
                <span className="mx-item-top"><strong>{who(email)}</strong><time dateTime={new Date(email.timestamp||0).toISOString()} title={fullWhen(email)}>{listWhen(email)}</time></span>
                <span className="mx-subject">{email.subject || '(Sin asunto)'}</span>
                <span className="mx-snippet">{email.snippet}</span>
                {(category || risky) && <span className="mx-tags">
                  {category && category!=='Sin clasificar' && <span className={`mx-tag ${manual?'mx-manual':''}`} title={manual?'Clasificado a mano':'Clasificación automática'}>{manual && <Tag aria-hidden="true"/>}{category}</span>}
                  {risky && <span className={`mx-tag mx-risk ${email.insights!.level}`}>{email.insights!.label}</span>}
                </span>}
              </span>
            </button>;
          })}
        {/* A full page means there may be older messages; the demo mailbox has no more to load. */}
        {!loading && !inDrafts && p.connected && source.length>=p.loadLimit && p.loadLimit<p.maxLoaded && <div className="mx-more">
          <button type="button" className="pa-btn pa-btn-secondary" onClick={p.onLoadMore} disabled={p.loadingMore}><RefreshCw aria-hidden="true" className={p.loadingMore?'spin':''}/>{p.loadingMore?'Cargando…':'Cargar más correos'}</button>
          <small>{source.length} cargados · hasta {p.maxLoaded}</small>
        </div>}
        {!loading && !inDrafts && p.connected && source.length>=p.maxLoaded && <div className="mx-more"><small>Se muestran los {p.maxLoaded} más recientes. Usa la búsqueda o pide al asistente un correo concreto para ver otros.</small></div>}
      </div>

      <article className="gmail-message-reader mx-reader" aria-label="Contenido del correo">
        {selected ? <div className="mx-reader-inner">
          <button type="button" className="pa-btn pa-btn-ghost gmail-back" onClick={()=>setSelectedId(null)}><ArrowLeft aria-hidden="true"/>Volver</button>
          <header className="mx-reader-head">
            <h2>{selected.subject || '(Sin asunto)'}</h2>
            <div className="mx-sender">
              <span className="mx-avatar lg" aria-hidden="true">{initial(selected.senderName)}</span>
              <div><strong>{selected.senderName}</strong><span>{selected.sender}</span><span>Para: {selected.recipient}</span></div>
              <span className="mx-sender-side">
                <time dateTime={new Date(selected.timestamp||0).toISOString()}>{fullWhen(selected)}</time>
                {webUrl && <a className="mx-open-web" href={webUrl} target="_blank" rel="noopener noreferrer" title={`Abre este correo en ${MAIL} en una pestaña nueva`}><ExternalLink aria-hidden="true"/>Abrir en {MAIL}</a>}
              </span>
            </div>
            {manualOf(selected).length>0 && <div className="mx-tags">{manualOf(selected).map(c=><span key={c} className="mx-tag mx-manual"><Tag aria-hidden="true"/>{c}</span>)}</div>}
            <div className="mx-reader-actions">
              {inSpam
                ? <>
                  <BusyButton className="pa-btn pa-btn-secondary" disabled={busy} busyLabel="Moviendo…" onClick={()=>run(async()=>{await p.onNotSpam([selected.id]);setSelectedId(null);})}><MailCheck aria-hidden="true"/>No es spam · mover a Entrada</BusyButton>
                  <BusyButton className="pa-btn pa-btn-danger-ghost" disabled={busy} busyLabel="Moviendo…" onClick={()=>run(async()=>{await onTrash([selected.id]);setSelectedId(null);})}><Trash2 aria-hidden="true"/>Mover a la papelera</BusyButton>
                </>
                : inTrash
                ? <BusyButton className="pa-btn pa-btn-primary" disabled={busy} busyLabel="Recuperando…" onClick={()=>run(async()=>{await p.onRestore([selected.id]);setSelectedId(null);})}><Undo2 aria-hidden="true"/>Recuperar a la bandeja de entrada</BusyButton>
                : <>
                  <button type="button" className="pa-btn pa-btn-primary" onClick={()=>p.onReplyWithAI(selected)}><Sparkles aria-hidden="true"/>Responder con IA</button>
                  <button type="button" className="pa-btn pa-btn-secondary" onClick={()=>p.onCompose({replyToSender:inSent?undefined:selected.sender,to:inSent?selected.recipient.replace(/^.*<([^>]+)>.*$/,'$1'):selected.sender,subject:selected.subject.toLowerCase().startsWith('re:')?selected.subject:`Re: ${selected.subject}`})}><Reply aria-hidden="true"/>Responder</button>
                  <label className="mx-classify">
                    <Tag aria-hidden="true"/>
                    <span className="mx-classify-label">Clasificar</span>
                    <select aria-label="Clasificar este correo" disabled={busy} value={manualOf(selected)[0] ?? ''} onChange={event=>{const value=event.target.value;run(()=>p.onSetCategory(selected,value || null),'classify');}}>
                      <option value="">{manualOf(selected).length?'Quitar clasificación':'Elegir categoría…'}</option>
                      {MANUAL_CATEGORIES.map(category=><option key={category} value={category}>{category}</option>)}
                    </select>
                    {busyWhat==='classify' && <span className="mx-busy" role="status"><Loader2 aria-hidden="true" className="spin"/>Guardando…</span>}
                  </label>
                  <details className="ox-more">
                    <summary className="pa-btn pa-btn-secondary"><MoreHorizontal aria-hidden="true"/>Más</summary>
                    <div className="ox-menu" role="menu">
                      {!inSent && <button type="button" role="menuitem" disabled={busy} onClick={async event=>{(event.currentTarget.closest('details') as HTMLDetailsElement|null)?.removeAttribute('open');if(await confirmSpam(selected))run(async()=>{await p.onMarkSpam([selected.id]);setSelectedId(null);},'spam');}}>{busyWhat==='spam'?<Loader2 aria-hidden="true" className="spin"/>:<ShieldAlert aria-hidden="true"/>}{busyWhat==='spam'?'Moviendo…':'Mover a No deseado'}</button>}
                      <button type="button" role="menuitem" disabled={selected.read || busy} onClick={()=>run(()=>onMarkRead(selected.id),'read')}>{busyWhat==='read'?<Loader2 aria-hidden="true" className="spin"/>:<MailCheck aria-hidden="true"/>}{busyWhat==='read'?'Marcando…':selected.read?'Ya está leído':'Marcar como leído'}</button>
                    </div>
                  </details>
                  {!inSent && selected.insights?.level==='high' && <BusyButton className="pa-btn pa-btn-danger-ghost" disabled={busy} busyLabel="Moviendo…" title={`Lo mueve a No deseado y ${MAIL} aprende a filtrar correos parecidos`} onClick={async()=>{if(await confirmSpam(selected))run(async()=>{await p.onMarkSpam([selected.id]);setSelectedId(null);});}}><ShieldAlert aria-hidden="true"/>Reportar como spam</BusyButton>}
                  <BusyButton className="pa-btn pa-btn-danger-ghost mx-trash" disabled={busy} busyLabel="Moviendo a la papelera…" onClick={()=>run(async()=>{await onTrash([selected.id]);})}><Trash2 aria-hidden="true"/>Mover a la papelera</BusyButton>
                </>}
            </div>
            {inSpam && <p className="mx-classify-note">{MAIL} lo marcó como no deseado. Si no reconoces al remitente, no abras sus enlaces ni adjuntos. «No es spam» lo devuelve a Entrada y le enseña a {MAIL} que es legítimo.</p>}
            {!inTrash && !inSpam && <p className="mx-classify-note">La categoría se guarda como etiqueta en tu {MAIL} y tiene prioridad sobre la agrupación automática. Los envíos se aprueban en Acciones.</p>}
          </header>
          {selected.insights && <MailSafety report={selected.insights} onVerify={!inSent && p.onVerifyByOtherChannel?()=>p.onVerifyByOtherChannel!(selected):undefined}/>}
          <p className="mx-safe"><ShieldCheck aria-hidden="true"/>Lectura protegida: el contenido activo se bloquea, cada enlace se revisa antes de abrirlo y las imágenes externas no se cargan hasta que lo pidas.</p>
          <MailAttachments key={`att-${selected.id}`} email={selected} risky={!!selected.insights && selected.insights.level!=='none'} onList={email=>p.onListAttachments(email).then(list=>list.filter(attachment=>!isInlineImage(attachment,email)))} onDownload={p.onDownloadAttachment} onFindings={p.onAttachmentFindings}/>
          <MailDocument key={selected.id} inline={inlineImages} html={selected.bodyHtml} text={selected.body} senderDomain={selected.sender.split('@').pop()} verified={selected.insights?.sender?.status==='verified'} knownSender={!!selected.insights?.notes.some(note=>/^Enlaces de seguimiento de .+ ya te ha escrito antes/.test(note))}/>
        </div> : <div className="pa-empty mx-reader-empty"><Mail aria-hidden="true"/><h3>Selecciona un correo</h3><p>{inTrash?'Ábrelo para revisarlo y recuperarlo si lo necesitas.':'Su contenido aparecerá aquí para que lo leas con calma.'}</p></div>}
      </article>
    </div>
    </>}
  </div>;
}
