import {useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,ExternalLink,Link2,ShieldAlert,X} from 'lucide-react';
import {mailDocument} from '@shared/mail/mail-document';
import {checkLink} from '@shared/mail/mail-insights';

/** Web addresses written as plain text, for messages without HTML. */
const TEXT_LINK=/(?:https?:\/\/|www\.)[^\s<>"']+/gi;

export function MailDocument({html,text,senderDomain,verified,knownSender}:{html?:string;text:string;senderDomain?:string;verified?:boolean;knownSender?:boolean}){
  const [images,setImages]=useState(false),[plain,setPlain]=useState(false);
  const content=useMemo(()=>mailDocument(html || '',images),[html,images]);
  // Every link is checked on this device before it is offered: where it really goes and whether it tries to deceive.
  const links=useMemo(()=>{
    const found=html?content.links:[...new Set((text.match(TEXT_LINK) ?? []).map(link=>link.replace(/[.,;)\]}]+$/,'')))].slice(0,100).map(href=>({href,text:''}));
    return found.map(link=>({...link,check:checkLink(link.href,link.text,{senderDomain,verified,knownSender})}));
  },[html,text,content.links,senderDomain,verified,knownSender]);
  const warned=links.filter(link=>link.check.findings.some(f=>f.weight>0)).length;
  const [linksOpen,setLinksOpen]=useState(warned>0);
  /** Shown when the person clicks inside the message, where links cannot open. */
  const [hint,setHint]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null),list=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{setLinksOpen(warned>0);setHint(false);},[html,text,warned]);

  // The message is locked (no scripts), so a click inside it cannot be seen directly. When the page loses
  // focus to the message frame, the person clicked in it: most likely on a link that did nothing.
  useEffect(()=>{
    if(!links.length)return;
    let timer=0;
    const onBlur=()=>window.setTimeout(()=>{
      if(document.activeElement!==frame.current)return;
      setHint(true);window.clearTimeout(timer);timer=window.setTimeout(()=>setHint(false),12000);
      // Take the focus back so the next click in the message is noticed too.
      frame.current?.blur();window.focus();
    },0);
    window.addEventListener('blur',onBlur);
    return()=>{window.removeEventListener('blur',onBlur);window.clearTimeout(timer);};
  },[links.length]);

  function showLinks(){
    setHint(false);setLinksOpen(true);
    requestAnimationFrame(()=>{list.current?.scrollIntoView({behavior:'smooth',block:'start'});list.current?.querySelector('summary')?.focus({preventScroll:true});});
  }

  function open(link:typeof links[number]){
    const {check}=link;
    if(!check.url || check.blocked){window.alert('Este enlace no se puede abrir de forma segura.\n\n'+link.href);return;}
    const destination=check.url.href;
    const warnings=check.findings.filter(f=>f.weight>0);
    const message=warnings.length
      ? `${check.danger?'⚠️ ESTE ENLACE PARECE ENGAÑOSO':'Revisa este enlace antes de abrirlo'}\n\n${warnings.map(f=>'• '+f.reason).join('\n')}\n\nVa a: ${check.domain}\n${destination}\n\n${check.danger?'¿Seguro que quieres abrirlo? Si no esperabas este correo, no lo abras.':'¿Abrirlo en una pestaña nueva?'}`
      : `Vas a abrir un sitio externo:\n\n${check.domain}\n${destination}\n\nNexoMail revisó la dirección y no encontró señales de engaño, pero no puede garantizar que el sitio sea seguro. ¿Abrirlo en una pestaña nueva?`;
    if(window.confirm(message))window.open(destination,'_blank','noopener,noreferrer');
  }

  const linkCount=links.length===1?'1 enlace':`${links.length} enlaces`;
  return <section className="nexo-mail-document">
    <div className="nexo-reader-controls"><strong>Contenido del mensaje</strong><div>{html && <><button type="button" onClick={()=>setPlain(!plain)}>{plain?'Ver diseño':'Ver texto'}</button><button type="button" onClick={()=>setImages(!images)}>{images?'Ocultar imágenes':'Mostrar imágenes'}</button></>}</div></div>
    {links.length>0 && <aside className="lk-banner">
      <Link2 aria-hidden="true"/>
      <div><strong>Los enlaces no se abren pulsándolos en el correo</strong>
        <p>Este correo tiene {linkCount}. Por seguridad, NexoMail lo muestra en una vista bloqueada, para que un enlace engañoso no se abra con un clic sin querer. Para abrir uno, usa «Enlaces del mensaje»: verás adónde lleva de verdad y NexoMail lo revisará antes de abrirlo.</p></div>
      <button type="button" className="pa-btn pa-btn-secondary" onClick={showLinks}>Ver enlaces{warned>0?` · ${warned} con avisos`:''}</button>
    </aside>}
    {html && !plain?<>
      <p className="nexo-reader-note">{images?'Imágenes externas habilitadas para este mensaje.':'Las imágenes externas están bloqueadas para proteger tu privacidad.'}</p>
      <div className="lk-frame">
        <iframe ref={frame} title="Diseño del correo" sandbox="" referrerPolicy="no-referrer" srcDoc={content.document} className="nexo-mail-frame"/>
        {hint && <div className="lk-hint" role="status">
          <Link2 aria-hidden="true"/>
          <span>Los enlaces no se abren desde aquí. Ábrelos en «Enlaces del mensaje», al final del correo.</span>
          <button type="button" className="pa-btn pa-btn-primary" onClick={showLinks}>Ver enlaces</button>
          <button type="button" className="lk-hint-close" aria-label="Cerrar aviso" onClick={()=>setHint(false)}><X aria-hidden="true"/></button>
        </div>}
      </div>
    </>:<div className="nexo-mail-text">{text}</div>}
    {links.length>0 && <details ref={list} className="nexo-message-links" open={linksOpen} onToggle={event=>setLinksOpen(event.currentTarget.open)}>
      <summary>Enlaces del mensaje ({links.length}){warned>0 && <span className="lk-count">{warned===1?'1 con avisos':`${warned} con avisos`}</span>}</summary>
      <p>Pulsa un enlace para abrirlo. NexoMail revisa la dirección en tu equipo, sin visitarla; no consulta listas de sitios maliciosos. Si no esperabas el correo, no abras sus enlaces.</p>
      <ul className="lk-list">
        {links.map(link=>{
          const {check}=link;
          const tone=check.danger?'danger':check.findings.some(f=>f.weight>0)?'warn':'ok';
          return <li key={link.href} className={`lk-item lk-${tone}`}>
            <button type="button" onClick={()=>open(link)} title={link.href}>
              <span className="lk-icon" aria-hidden="true">{tone==='danger'?<ShieldAlert/>:tone==='warn'?<AlertTriangle/>:<ExternalLink/>}</span>
              <span className="lk-text">
                <strong>{check.blocked?'Enlace bloqueado':check.domain || 'Destino no interpretable'}</strong>
                {link.text && link.text!==link.href && <small className="lk-shown">Texto del enlace: «{link.text.slice(0,80)}»</small>}
                <small className="lk-url">{link.href}</small>
                {check.declared && <small className="lk-shown">Destino que declara el enlace: {check.declared.length>90?check.declared.slice(0,90)+'…':check.declared}</small>}
                {check.findings.map(f=><small key={f.reason} className={f.weight>0?"lk-reason":"lk-info"}>{f.reason}</small>)}
              </span>
            </button>
          </li>;
        })}
      </ul>
    </details>}
  </section>;
}
