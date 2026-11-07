import {loadConfiguration} from './configuration.js';
import {getPageContext} from './page-context.js';
import {detectPlatform} from './platform.js';
import {installGoogleAuth} from './google-auth.js';
import './microsoft-session.js';
// Session credentials stay in the extension's private in-memory storage.
chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(()=>{});
let googleHostPromise;
function googleHost(){
  if(!googleHostPromise)googleHostPromise=(async()=>{const host={config:{}};await installGoogleAuth(host);return host;})();
  return googleHostPromise;
}
// Tokens are returned only to our extension pages, never to content scripts.
// One worker coordinates renewals across multiple panels.
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=='EMAILAGENT_GOOGLE_AUTH')return;
  if(sender.id!==chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))return;
  const methods=new Set(['googleLogin','googleRestore','googleAccessToken','googleInvalidateToken','googleDisconnect']);
  if(!methods.has(message.method) || !Array.isArray(message.args) || message.args.length>1 || message.args.some(arg=>typeof arg!=='string' || arg.length>16384)){reply({ok:false,error:'Solicitud de autorización no válida.'});return;}
  googleHost().then(async host=>{
    host.config=await loadConfiguration();
    let context=await getPageContext(message.contextKey,sender);
    if(context && context.provider!=='gmail')throw new Error('Esta autorización pertenece a Gmail.');
    const binding=context?'nexomail.google.tab.'+host.config.googleClientId+'.'+context.tabId+'.'+encodeURIComponent(context.slot):'';
    if(binding && !context.email && message.method!=='googleLogin'){
      const saved=(await chrome.storage.session.get(binding))[binding];
      if(saved?.email)context={...context,email:saved.email};
    }
    const result=await host[message.method](...message.args,context);
    if(binding && result?.email && ['googleLogin','googleRestore'].includes(message.method))await chrome.storage.session.set({[binding]:{email:result.email.toLowerCase()}});
    if(binding && message.method==='googleDisconnect')await chrome.storage.session.remove(binding);
    return result;
  }).then(value=>reply({ok:true,value:value ?? null})).catch(error=>reply({ok:false,error:error instanceof Error?error.message:'No se pudo recuperar la sesión de Google.'}));
  return true;
});
chrome.action.onClicked.addListener(async tab=>{
  if(!tab?.id || !detectPlatform(tab.url)){chrome.runtime.openOptionsPage();return;}
  try{await chrome.tabs.sendMessage(tab.id,{type:'EMAILAGENT_TOGGLE_FLOATING'});await chrome.action.setBadgeText({tabId:tab.id,text:''});}
  catch{await chrome.action.setBadgeText({tabId:tab.id,text:'!'});await chrome.action.setTitle({tabId:tab.id,title:'Recarga Gmail u Outlook para activar la burbuja de NexoMail.'});}
});
chrome.tabs.onUpdated.addListener((id,change,tab)=>{if(change.status==='complete' && detectPlatform(tab.url)){chrome.action.setBadgeText({tabId:id,text:''});chrome.action.setTitle({tabId:id,title:'Abrir o minimizar el chat flotante'});}});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type==='EMAILAGENT_OPTIONS' && sender.id===chrome.runtime.id && sender.tab?.id && detectPlatform(sender.url)){chrome.runtime.openOptionsPage().then(()=>reply({ok:true}));return true;}
});
// Reload requested from NexoMail's own pages. Chrome re-reads the files from disk, so a fresh build applies without chrome://extensions.
const RELOAD_KEY='nexomail.reload';
const MAIL_TABS=chrome.runtime.getManifest().content_scripts.flatMap(script=>script.matches);
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=='NEXOMAIL_RELOAD_EXTENSION')return;
  if(sender.id!==chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))return;
  // Only the place the button was pressed is reloaded: the mail tab holding the floating panel,
  // or the NexoMail page itself (extension pages close on reload, so it is opened again).
  const fromPanel=sender.frameId!==0 && sender.tab?.id!==undefined && detectPlatform(sender.tab.url);
  const plan={at:Date.now(),reloadTab:fromPanel?sender.tab.id:null,reopenUrl:fromPanel?null:sender.url};
  chrome.storage.local.set({[RELOAD_KEY]:plan})
    .then(()=>{reply({ok:true});setTimeout(()=>chrome.runtime.reload(),200);})
    .catch(()=>reply({ok:false,error:'No se pudo recargar la extensión.'}));
  return true;
});
// After a reload the scripts left in open mail tabs are disconnected. The tab where the reload was asked for is
// refreshed; the others get NexoMail injected again in place, without reloading the page.
chrome.storage.local.get(RELOAD_KEY).then(async stored=>{
  const plan=stored[RELOAD_KEY];
  if(!plan)return;
  await chrome.storage.local.remove(RELOAD_KEY);
  if(Date.now()-plan.at>60000)return;
  const tabs=await chrome.tabs.query({url:MAIL_TABS});
  await Promise.all(tabs.map(async tab=>{
    if(!tab.id)return;
    if(tab.id===plan.reloadTab){await chrome.tabs.reload(tab.id).catch(()=>{});return;}
    if(tab.status!=='complete' || tab.discarded)return;
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['page-account.js','content.js']}).catch(()=>{});
  }));
  if(plan.reopenUrl?.startsWith(chrome.runtime.getURL('')))await chrome.tabs.create({url:plan.reopenUrl}).catch(()=>{});
}).catch(()=>{});
