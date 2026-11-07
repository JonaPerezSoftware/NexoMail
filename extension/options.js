// Theme: the same choice the NexoMail app stores (same extension origin).
try{const theme=localStorage.getItem('theme');if(theme==='light'||theme==='dark')document.documentElement.setAttribute('data-theme',theme);}catch{}

const fields=['googleClientId','microsoftClientId','microsoftTenant','pairingToken'];
const $=id=>document.getElementById(id);
const GUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let defaults,saved={};

function setNote(id,text,tone){const el=$(id);el.textContent=text;if(tone)el.dataset.tone=tone;else delete el.dataset.tone;}
function current(){const value={};for(const key of fields)value[key]=$(key).value.trim();return value;}
function markDirty(){const now=current();const dirty=fields.some(key=>now[key]!==(saved[key] ?? ''));const bar=document.querySelector('.op-savebar');if(dirty){bar.dataset.dirty='';setNote('status','');}else delete bar.dataset.dirty;}

/** Shows the problem under the field instead of a single message at the bottom. */
function validate(){
  const checks=[
    ['googleClientId','googleHelp',v=>!v || v.endsWith('.apps.googleusercontent.com'),'Este Client ID no termina en .apps.googleusercontent.com.'],
    ['microsoftClientId','microsoftHelp',v=>!v || GUID.test(v),'Debe tener formato GUID, por ejemplo 8e0d59dc-8a0f-4239-bab3-c82a0c145ac4.'],
  ];
  let firstInvalid=null;
  for(const [field,help,ok,message] of checks){
    const input=$(field),note=$(help),valid=ok(input.value.trim());
    input.setAttribute('aria-invalid',String(!valid));
    if(valid){note.textContent=note.dataset.help;delete note.dataset.invalid;}
    else{note.textContent=message;note.dataset.invalid='';firstInvalid??=input;}
  }
  return firstInvalid;
}

async function init(){
  $('version').textContent='v'+chrome.runtime.getManifest().version;
  $('googleRedirect').textContent=chrome.identity.getRedirectURL('google');
  $('microsoftRedirect').textContent=chrome.identity.getRedirectURL('microsoft');
  const {loadConfiguration}=await import('./configuration.js');
  defaults=await loadConfiguration();
  for(const key of fields){$(key).value=defaults[key] ?? '';saved[key]=$(key).value.trim();}
  $('microsoftApplication').textContent=saved.microsoftClientId || 'sin configurar';
}

$('config').addEventListener('input',()=>{markDirty();});
$('config').addEventListener('change',markDirty);
for(const id of ['googleClientId','microsoftClientId'])$(id).addEventListener('blur',validate);

$('config').addEventListener('submit',async event=>{
  event.preventDefault();
  const invalid=validate();
  if(invalid){setNote('status','Revisa los campos marcados.','error');invalid.focus();return;}
  const config={...defaults,...current()};
  const save=$('save');save.disabled=true;save.textContent='Guardando…';
  try{
    await chrome.storage.local.set({emailagentConfig:config});
    saved=current();markDirty();
    $('microsoftApplication').textContent=config.microsoftClientId || 'sin configurar';
    setNote('status','Guardado. Cierra y vuelve a abrir el panel de NexoMail para aplicarlo.','ok');
  }catch{setNote('status','No se pudo guardar. Vuelve a intentarlo.','error');}
  finally{save.disabled=false;save.textContent='Guardar cambios';}
});

$('togglePairing').addEventListener('click',()=>{
  const input=$('pairingToken'),show=input.type==='password';
  input.type=show?'text':'password';
  $('togglePairing').textContent=show?'Ocultar':'Mostrar';
  $('togglePairing').setAttribute('aria-pressed',String(show));
});

$('check').addEventListener('click',async()=>{
  const pill=$('serverPill'),button=$('check');
  const state=(value,text)=>{pill.dataset.state=value;$('serverPillText').textContent=text;};
  button.disabled=true;button.textContent='Comprobando…';setNote('serverStatus','');
  try{
    const res=await fetch('http://127.0.0.1:8000/api/health',{headers:{'X-EmailAgent-Token':$('pairingToken').value.trim()},signal:AbortSignal.timeout(6000)});
    if(res.ok){state('ok','Conectado');setNote('serverStatus','El servidor responde. Esto no prueba una consulta de IA.','ok');}
    else if(res.status===401){state('error','Clave incorrecta');setNote('serverStatus','La clave de enlace no coincide con la del servidor.','error');}
    else{state('error','Error '+res.status);setNote('serverStatus','El servidor respondió con un error ('+res.status+').','error');}
  }catch{state('error','Sin conexión');setNote('serverStatus','No hay conexión. Ejecuta INICIAR_SERVIDOR.cmd y vuelve a comprobar.','error');}
  finally{button.disabled=false;button.textContent='Comprobar conexión';}
});

for(const button of document.querySelectorAll('[data-copy]')){
  button.addEventListener('click',async()=>{
    const text=chrome.identity.getRedirectURL(button.dataset.copy);
    try{await navigator.clipboard.writeText(text);button.textContent='Copiada';}
    catch{button.textContent='Cópiala a mano';}
    setTimeout(()=>{button.textContent='Copiar';},2000);
  });
}

init().catch(()=>setNote('status','No se pudo cargar la configuración.','error'));

$('reload').addEventListener('click',async()=>{
  const dirty=document.querySelector('.op-savebar')?.hasAttribute('data-dirty');
  if(!window.confirm((dirty?'Tienes cambios sin guardar en esta página y se perderán.\n\n':'')+'Se recargará NexoMail. Las pestañas de Gmail y Outlook no se recargan: NexoMail se vuelve a conectar en ellas.\n\n¿Recargar ahora?'))return;
  const button=$('reload');button.disabled=true;button.textContent='Recargando…';setNote('reloadStatus','');
  try{const result=await chrome.runtime.sendMessage({type:'NEXOMAIL_RELOAD_EXTENSION'});if(!result?.ok)throw new Error(result?.error);}
  catch{button.disabled=false;button.textContent='Recargar extensión';setNote('reloadStatus','No se pudo recargar. Hazlo desde chrome://extensions.','error');}
});
