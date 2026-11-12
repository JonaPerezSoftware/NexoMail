// Libreta de contactos: la IA recuerda las direcciones a las que ya escribiste aunque esos correos
// ya no estén entre los 50 cargados. Ejecutar desde la raíz: node apps/gmail/tests/contacts.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/,'');
const {createServer}=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js').href);
const mem=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}};
globalThis.localStorage=mem();globalThis.sessionStorage=mem();
globalThis.window={emailAgentHost:{config:{apiBaseUrl:'http://x',pairingToken:'t',googleClientId:'x',microsoftClientId:'id'},pageAccount:null},location:{},addEventListener(){}};
// No AI configured: the local rules engine answers.
globalThis.fetch=async()=>new Response(JSON.stringify({configured:false}));
const vite=await createServer({root,configFile:root+'/vite.config.ts',server:{middlewareMode:true,hmr:false,ws:false},appType:'custom',logLevel:'error'});
const contacts=await vite.ssrLoadModule('/src/services/contacts.ts');
const tools=await vite.ssrLoadModule('/src/services/agentTools.ts');
const {agentEngine}=await vite.ssrLoadModule('/src/services/agentEngine.ts');
const {mailProvider}=await vite.ssrLoadModule('/src/services/mailProvider.ts');
let fails=0;const check=(n,ok,info='')=>{if(!ok)fails++;console.log((ok?'OK   ':'FALLO')+' '+n+(ok?'':' -> '+info));};
const S=mailProvider.getSessionKey();
const mk=(id,over)=>({id,sender:'yo@miempresa.com',senderName:'Yo',recipient:'',subject:'S',snippet:'',body:'',date:'',timestamp:Date.now(),read:true,category:'Sin clasificar',priority:'normal',labels:['SENT'],...over});

console.log('— Aprende de la carpeta de enviados');
const sent=[
  mk('s1',{recipient:'aalmeidac7@unemi.edu.ec',timestamp:Date.now()-200*86400000}),
  mk('s2',{recipient:'"Elena Terranova" <eterranovav@unemi.edu.ec>, Carlos Ruiz <cruiz@empresa.com>'}),
  mk('s3',{recipient:'cruiz@empresa.com'}),
  mk('r1',{labels:['INBOX'],sender:'ana.gomez@empresa.com',senderName:'Ana Gómez'}),
  mk('r2',{labels:['INBOX'],sender:'no-reply@banco.com',senderName:'Banco'}),
  mk('s4',{recipient:'ana.lopez@otra.com'}),
  mk('s5',{recipient:'Luis Pérez <lperez@uno.com>, Luis Mora <lmora@dos.com>'}),
];
contacts.learnContacts(S,sent,'yo@miempresa.com');
contacts.learnContacts(S,sent,'yo@miempresa.com'); // the same messages on the next refresh
check('«almeida» → aalmeidac7@unemi.edu.ec (parte de la dirección)',contacts.findContacts(S,'almeida')[0]?.address==='aalmeidac7@unemi.edu.ec');
check('«Elena Terranova» → por el nombre',contacts.findContacts(S,'Elena Terranova')[0]?.address==='eterranovav@unemi.edu.ec');
check('«la profesora Almeida» → ignora el título',contacts.findContacts(S,'la profesora Almeida')[0]?.address==='aalmeidac7@unemi.edu.ec');
check('Volver a ver los mismos correos no duplica la cuenta',contacts.findContacts(S,'cruiz')[0]?.sent===2,JSON.stringify(contacts.findContacts(S,'cruiz')[0]));
check('Los sistemas automáticos (no-reply) no son contactos',contacts.findContacts(S,'banco').length===0);
check('Quien te escribió también se recuerda',contacts.findContacts(S,'Ana Gómez')[0]?.address==='ana.gomez@empresa.com');
check('«ana» es ambiguo: dos contactos',contacts.findContacts(S,'ana').length===2);
const stored=localStorage.getItem('nexomail.contacts.'+S)||'';
check('Solo guarda direcciones, nombres y cuentas (nunca asuntos ni contenido)',!/"subject"|"body"/.test(stored)&&stored.includes('aalmeidac7'));
contacts.recordSent(S,'nuevo@cliente.com');
check('Un envío aprobado en NexoMail se recuerda',contacts.findContacts(S,'nuevo')[0]?.address==='nuevo@cliente.com');

console.log('\n— La herramienta de envío resuelve nombres');
const ctx={emails:[],isReal:false,sessionKey:S,providerSource:'x',strictMode:true};
let r=tools.executeAgentTool('prepare_send_email',{recipient:'almeida',subject:'Hola',body:'Hola, ¿cómo estás?'},ctx);
check('recipient «almeida» → propuesta para aalmeidac7@unemi.edu.ec',r.pendingActions[0]?.payload.recipient==='aalmeidac7@unemi.edu.ec',r.content);
r=tools.executeAgentTool('prepare_send_email',{recipient:'ana',subject:'Hola',body:'Hola'},ctx);
check('Nombre ambiguo → no prepara nada y lista candidatos',!r.pendingActions.length && /AMBIGUOUS_RECIPIENT/.test(r.content) && /ana.lopez@otra.com/.test(r.content),r.content);
r=tools.executeAgentTool('prepare_send_email',{recipient:'desconocido',subject:'Hola',body:'Hola'},ctx);
check('Nombre que no está en la libreta → sigue pidiendo una dirección válida',!r.pendingActions.length && /INVALID_RECIPIENT/.test(r.content),r.content);

console.log('\n— El motor local (sin IA) también los usa');
agentEngine.clearHistory();
let a=await agentEngine.processPrompt('Envía un correo a almeida diciendo que mañana entrego el informe');
check('«Envía un correo a almeida…» → propuesta para su dirección',a.pendingActions[0]?.payload.recipient==='aalmeidac7@unemi.edu.ec',a.finalAnswer+' '+JSON.stringify(a.pendingActions[0]?.payload));
agentEngine.clearHistory();
a=await agentEngine.processPrompt('Envía un correo a Luis diciendo hola');
check('Nombre ambiguo → pregunta a cuál, sin preparar nada',!a.pendingActions.length && /varios contactos/.test(a.finalAnswer),a.finalAnswer);

console.log(fails?`\nHAY FALLOS (${fails})`:'\nTODO OK');
await vite.close();
process.exitCode=fails?1:0;
