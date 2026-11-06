import {useMemo,useState} from 'react';
import {mailDocument} from '@shared/mail/mail-document';
export function MailDocument({html,text}:{html?:string;text:string}){
  const [images,setImages]=useState(false),[plain,setPlain]=useState(false);
  const content=useMemo(()=>mailDocument(html || '',images),[html,images]);
  return <section className="nexo-mail-document">
    <div className="nexo-reader-controls"><strong>Contenido del mensaje</strong><div>{html && <><button type="button" onClick={()=>setPlain(!plain)}>{plain?'Ver diseño':'Ver texto'}</button><button type="button" onClick={()=>setImages(!images)}>{images?'Ocultar imágenes':'Mostrar imágenes'}</button></>}</div></div>
    {html && !plain?<><p className="nexo-reader-note">{images?'Imágenes externas habilitadas para este mensaje.':'Las imágenes externas están bloqueadas para proteger tu privacidad.'} El contenido activo está bloqueado.</p><iframe title="Diseño del correo" sandbox="" referrerPolicy="no-referrer" srcDoc={content.document} className="nexo-mail-frame"/></>:<div className="nexo-mail-text">{text}</div>}
    {html && content.links.length>0 && <details className="nexo-message-links"><summary>Enlaces del mensaje ({content.links.length})</summary><p>Comprueba el dominio antes de abrir un enlace.</p>{content.links.map(link=><button type="button" key={link} onClick={()=>{if(window.confirm('¿Abrir este enlace externo?\n\n'+link))window.open(link,'_blank','noopener,noreferrer');}}>{link}</button>)}</details>}
  </section>;
}
