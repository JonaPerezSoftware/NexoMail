import {useMemo,useState} from 'react';
import {AlertTriangle,ExternalLink,ShieldAlert} from 'lucide-react';
import {mailDocument} from '@shared/mail/mail-document';
import {checkLink} from '@shared/mail/mail-insights';

/** Web addresses written as plain text, for messages without HTML. */
const TEXT_LINK=/(?:https?:\/\/|www\.)[^\s<>"']+/gi;

export function MailDocument({html,text}:{html?:string;text:string}){
  const [images,setImages]=useState(false),[plain,setPlain]=useState(false);
  const content=useMemo(()=>mailDocument(html || '',images),[html,images]);
  // Every link is checked on this device before it is offered: where it really goes and whether it tries to deceive.
  const links=useMemo(()=>{
    const found=html?content.links:[...new Set((text.match(TEXT_LINK) ?? []).map(link=>link.replace(/[.,;)\]}]+$/,'')))].slice(0,100).map(href=>({href,text:''}));
    return found.map(link=>({...link,check:checkLink(link.href,link.text)}));
  },[html,text,content.links]);
  const warned=links.filter(link=>link.check.findings.length>0).length;

  function open(link:typeof links[number]){
    const {check}=link;
    if(!check.url || check.blocked){window.alert('Este enlace no se puede abrir de forma segura.\n\n'+link.href);return;}
    const destination=check.url.href;
    const message=check.findings.length
      ? `${check.danger?'⚠️ ESTE ENLACE PARECE ENGAÑOSO':'Revisa este enlace antes de abrirlo'}\n\n${check.findings.map(f=>'• '+f.reason).join('\n')}\n\nVa a: ${check.domain}\n${destination}\n\n${check.danger?'¿Seguro que quieres abrirlo? Si no esperabas este correo, no lo abras.':'¿Abrirlo en una pestaña nueva?'}`
      : `Vas a abrir un sitio externo:\n\n${check.domain}\n${destination}\n\nNexoMail revisó la dirección y no encontró señales de engaño, pero no puede garantizar que el sitio sea seguro. ¿Abrirlo en una pestaña nueva?`;
    if(window.confirm(message))window.open(destination,'_blank','noopener,noreferrer');
  }

  return <section className="nexo-mail-document">
    <div className="nexo-reader-controls"><strong>Contenido del mensaje</strong><div>{html && <><button type="button" onClick={()=>setPlain(!plain)}>{plain?'Ver diseño':'Ver texto'}</button><button type="button" onClick={()=>setImages(!images)}>{images?'Ocultar imágenes':'Mostrar imágenes'}</button></>}</div></div>
    {html && !plain?<><p className="nexo-reader-note">{images?'Imágenes externas habilitadas para este mensaje.':'Las imágenes externas están bloqueadas para proteger tu privacidad.'} Los enlaces no se abren desde el mensaje: usa la lista de enlaces de abajo.</p><iframe title="Diseño del correo" sandbox="" referrerPolicy="no-referrer" srcDoc={content.document} className="nexo-mail-frame"/></>:<div className="nexo-mail-text">{text}</div>}
    {links.length>0 && <details className="nexo-message-links" open={warned>0}>
      <summary>Enlaces del mensaje ({links.length}){warned>0 && <span className="lk-count">{warned===1?'1 con avisos':`${warned} con avisos`}</span>}</summary>
      <p>NexoMail revisa la dirección de cada enlace en tu equipo, sin visitarlo. No consulta listas de sitios maliciosos: si no esperabas el correo, no abras sus enlaces.</p>
      <ul className="lk-list">
        {links.map(link=>{
          const {check}=link;
          const tone=check.danger?'danger':check.findings.length?'warn':'ok';
          return <li key={link.href} className={`lk-item lk-${tone}`}>
            <button type="button" onClick={()=>open(link)} title={link.href}>
              <span className="lk-icon" aria-hidden="true">{tone==='danger'?<ShieldAlert/>:tone==='warn'?<AlertTriangle/>:<ExternalLink/>}</span>
              <span className="lk-text">
                <strong>{check.blocked?'Enlace bloqueado':check.domain || 'Destino no interpretable'}</strong>
                {link.text && link.text!==link.href && <small className="lk-shown">Texto del enlace: «{link.text.slice(0,80)}»</small>}
                <small className="lk-url">{link.href}</small>
                {check.findings.map(f=><small key={f.reason} className="lk-reason">{f.reason}</small>)}
              </span>
            </button>
          </li>;
        })}
      </ul>
    </details>}
  </section>;
}
