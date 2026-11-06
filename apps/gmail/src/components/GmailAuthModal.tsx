import {useEffect,useState} from 'react';
import {mailProvider} from '../services/mailProvider';
import {realGmailProvider} from '../services/realGmailProvider';
import {ACCOUNT,MAIL,PLATFORM} from '../services/platform';
interface Props {isOpen:boolean;onClose:()=>void;onConnectSuccess:()=>void; onBeforeDisconnect?: () => Promise<void> | undefined;}
/** Account dialog for either mailbox. Gmail can take a Client ID here; Microsoft's comes from the extension options. */
export function GmailAuthModal({isOpen,onClose,onConnectSuccess, onBeforeDisconnect }:Props){
 const gmail=PLATFORM==='gmail';
 const [clientId,setClientId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(gmail)window.emailAgentHost.ready.then(()=>setClientId(window.emailAgentHost.config.googleClientId || '')).catch(()=>setError('No se pudo leer la configuración de la extensión.'));},[gmail]);
 if(!isOpen)return null;
 async function connect(){setBusy(true);setError('');try{
   if(gmail){const auth=await window.emailAgentHost.googleLogin(clientId.trim());realGmailProvider.saveConfig({...auth,clientSecret:'',redirectUri:''});}
   else await mailProvider.connect();
   onConnectSuccess();}catch(e){setError(e instanceof Error?e.message:`${ACCOUNT} no autorizó la conexión.`);}finally{setBusy(false);}}
 return <div className="modal-backdrop"><section className="modal-content auth-modal" role="dialog" aria-modal="true" aria-labelledby="gmail-auth-title"><div className="modal-header"><h3 id="gmail-auth-title">Conectar {MAIL}</h3><button className="close-btn" disabled={busy} onClick={onClose} aria-label="Cerrar">×</button></div><div className="modal-body-content">
 {mailProvider.isConnected()?<><p>Cuenta autorizada: <strong>{mailProvider.accountEmail() || MAIL}</strong></p><p>NexoMail comprueba que la cuenta autorizada coincida con la detectada en esta página.</p><button className="btn-approve" disabled={busy} onClick={connect}>{busy?`Esperando a ${ACCOUNT}…`:`Reautorizar con ${ACCOUNT}`}</button><button className="btn-reject" disabled={busy} onClick={async()=>{await onBeforeDisconnect?.();await mailProvider.disconnect();onConnectSuccess();}}>Desconectar esta cuenta</button></>:<><p>Autoriza tu cuenta mediante {ACCOUNT}. No necesitas copiar tokens, una contraseña de aplicación ni un Client Secret.</p>{gmail && <label>Google Client ID<input className="chat-input w-full" value={clientId} onChange={e=>setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" disabled={busy}/></label>}<button className="btn-approve" disabled={busy} onClick={connect}>{busy?'Esperando autorización…':`Autorizar con ${ACCOUNT}`}</button><button className="btn-reject" disabled={busy} onClick={()=>window.emailAgentHost.openOptions()}>Opciones de la extensión</button></>}
 {error && <p role="alert">{error}</p>}<p>La cuenta se recuerda y el acceso se renueva automáticamente cuando {ACCOUNT} lo permite. Si {ACCOUNT} requiere confirmación, pulsa Reautorizar con {ACCOUNT}. Los envíos y la papelera requieren revisión humana.</p></div></section></div>;
}
