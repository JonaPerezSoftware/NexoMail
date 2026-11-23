/** Local, deterministic analysis. Never fetches URLs, executes HTML or calls an LLM.
 */
import { type SenderAuth, isTrackingDomain, findLookalike, KNOWN_BRANDS, sameOrganization, baseName, redirectorOwner } from './sender-intel';
import { classifyMail, type MailCategory } from './mail-classifier';
export type { MailCategory } from './mail-classifier';
export interface MailInput {
  subject: string; sender: string; senderName?: string; text: string;
  html?: string; labels?: string[]; filenames?: string[];
  replyTo?: string; partial?: boolean; hasAttachments?: boolean;
  /** Arrived through a mailing list (List-Unsubscribe, List-Id or Precedence: bulk). */
  bulk?: boolean;
  /** Sender authentication read from the provider's Authentication-Results header. */
  auth?: SenderAuth;
}
export interface LinkFinding { domain: string; reasons: string[]; }
export interface MailInsights {
  categories: MailCategory[]; classificationReasons: string[];
  specificLabels: string[];
  /** Sent by a machine (mailing list, no-reply address, promotions), not written by a person. */
  automated?: boolean;
  level: 'high'|'review'|'none'; label: string; reasons: string[];
  links: LinkFinding[]; partial: boolean; hasAttachments: boolean;
  /** Sum of the warning weights: 4 or more is high risk. */
  score: number;
  /** Whether the mail service confirmed the sender (SPF/DKIM/DMARC). */
  sender?: SenderAuth;
  /** Context worth knowing that is not a warning (verified tracking links, first message from a domain…). */
  notes: string[];
  /** The text tries to give orders to an AI assistant: the agent must treat it with extra care. */
  aiInjection: boolean;
  /** Weight of each warning in `reasons`. */
  weights: Record<string,number>;
}

/** «The text shows one site but the link goes to another» on its own: worth a look, not proof of fraud. */
export const LINK_MISMATCH=/^El texto muestra .+, pero el enlace lleva a /;
/** Added when that mismatch comes with signs of deceit: then it is the usual shape of phishing. */
export const MISMATCH_WITH_DECEIT='Además de un enlace que no lleva al sitio que muestra, el correo tiene otras señales de engaño: es el patrón típico del phishing.';

/** Context that changes how a link is judged: a verified sender linking through its own click tracker is normal. */
export interface LinkContext { senderDomain?: string; verified?: boolean; /** Verified sender that has written to this account several times. */ knownSender?: boolean; }

/**
 * A message the account itself sent is not checked as a possible fraud: you wrote it. Its sender verification is
 * also absent by nature (the receiving server checks it, not yours). The categories stay; warnings are cleared.
 */
export function ownMessageInsights(insights:MailInsights):MailInsights{
  return {...insights,level:'none',label:'Enviado por ti',reasons:[],score:0,weights:{},sender:undefined,aiInjection:false,
    notes:['Lo enviaste tú desde esta cuenta: no se analiza como posible fraude.']};
}

/** Adds a warning to an existing analysis and recomputes its level (used for checks that need the mailbox history). */
export function addFinding(insights:MailInsights,reason:string,weight:number):MailInsights{
  if(insights.reasons.includes(reason) || insights.notes.includes(reason))return insights;
  if(weight<=0)return {...insights,notes:[...insights.notes,reason]};
  return relabel({...insights,reasons:[...insights.reasons,reason],score:insights.score+weight,weights:{...insights.weights,[reason]:weight}});
}
/**
 * Turns «the text shows one site, the link goes to another» into a note, for a verified sender you already know.
 * Nothing changes when the message also shows signs of deceit.
 */
export function downgradeMismatches(insights:MailInsights,note:string):MailInsights{
  if(insights.reasons.includes(MISMATCH_WITH_DECEIT))return insights;
  const dropped=insights.reasons.filter(reason=>LINK_MISMATCH.test(reason));
  if(!dropped.length)return insights;
  const weights={...insights.weights};let score=insights.score;
  for(const reason of dropped){score-=weights[reason] ?? 0;delete weights[reason];}
  return relabel({...insights,reasons:insights.reasons.filter(reason=>!dropped.includes(reason)),score:Math.max(0,score),weights,notes:insights.notes.includes(note)?insights.notes:[...insights.notes,note]});
}
function relabel(insights:MailInsights):MailInsights{
  const level=insights.score>=4?'high':insights.score>0?'review':'none';
  const label=level==='high'?'Posible phishing · Riesgo alto':level==='review'?'Para revisar':insights.sender?.status==='verified'?'Remitente verificado':insights.links.length?'Enlaces sin verificar':'Sin indicios detectados';
  return {...insights,level,label};
}
const MAX_CONTENT=120000, MAX_LINKS=80;
const clean=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const shorteners=new Set(['bit.ly','tinyurl.com','t.co','goo.gl','ow.ly','buff.ly','cutt.ly','is.gd','rb.gy','shorturl.at']);
const sensitiveFiles=/\.(?:exe|scr|com|bat|cmd|ps1|vbs|vbe|js|jse|msi|hta|lnk|iso|img)$/i;
const activeFiles=/\.(?:html?|svg|docm|xlsm|pptm|zip|rar|7z)$/i;
const host=(value:string)=>{try{return new URL(value).hostname.toLowerCase().replace(/\.$/,'');}catch{return '';}};
const related=(a:string,b:string)=>a===b || a.endsWith('.'+b) || b.endsWith('.'+a);

export interface LinkCheck {
  /** Destination as the browser would open it, or null if it cannot be read. */
  url:URL|null;
  domain:string;
  /** True for protocols other than http(s), which are never opened. */
  blocked:boolean;
  findings:{reason:string;weight:number;kind?:'mismatch'|'suspicious'}[];
  /** Weight 4 or more: the link most likely tries to deceive. */
  danger:boolean;
  /** Final address the link says it leads to (in a parameter such as link= or url=), never visited. */
  declared?:string;
}

/** Parameters where click counters and redirectors carry the final address. */
const REDIRECT_KEYS=new Set(['link','url','u','redirect','redirect_url','redirect_uri','redirecturl','target','dest','destination','goto','to','next','r','l','href','continue','returnurl','return','link_url','targeturl']);
/** The address a tracking or redirect link declares as its destination, read from its parameters. */
export function declaredTarget(url:URL):URL|null{
  for(const [name,raw] of url.searchParams){
    if(!REDIRECT_KEYS.has(name.toLowerCase()))continue;
    let value=raw.trim();
    for(let i=0;i<2 && !/^https?:\/\//i.test(value);i++){try{value=decodeURIComponent(value);}catch{break;}}
    if(!/^https?:\/\//i.test(value))continue;
    try{const target=new URL(value);if(['http:','https:'].includes(target.protocol))return target;}catch{/* not an address */}
  }
  return null;
}

/**
 * Checks one link on this device, without visiting it: where it really goes and whether its
 * address or visible text tries to deceive. It does not consult lists of known malicious sites.
 */
/** Common domain endings, plus any two-letter country ending that is not also a usual file or code extension. */
const COMMON_TLDS=new Set('com net org edu gov mil int info biz name pro coop aero museum mobi app dev io ai co me tv xyz online site store shop tech cloud email link click live news blog page top club world space website digital group agency bank finance money pay global solutions services support center company today life'.split(' '));
const NOT_TLDS=new Set('js ts md py sh rs cs go rb pl pm db gz h c cc cpp vb ps cf'.split(' '));
function looksLikeDomain(text:string):boolean{
  const tld=text.toLowerCase().split('.').pop() || '';
  if(COMMON_TLDS.has(tld))return true;
  return /^[a-z]{2}$/.test(tld) && !NOT_TLDS.has(tld);
}

export function checkLink(raw:string,visibleText='',context:LinkContext={}):LinkCheck{
  const trimmed=raw.trim();
  const expanded=trimmed.startsWith('//')?'https:'+trimmed:/^www\./i.test(trimmed)?'https://'+trimmed:trimmed;
  const findings:LinkCheck['findings']=[];
  const issue=(reason:string,weight:number,kind?:'mismatch'|'suspicious')=>{if(!findings.some(f=>f.reason===reason))findings.push({reason,weight,kind});};
  let url:URL;
  try{url=new URL(expanded);}catch{return {url:null,domain:'',blocked:false,findings:[{reason:'No se pudo comprobar el destino del enlace.',weight:1}],danger:false};}
  if(!['http:','https:'].includes(url.protocol)){
    issue('El enlace utiliza un protocolo que puede ejecutar contenido o abrir otra aplicación.',4);
    return {url,domain:'',blocked:true,findings,danger:true};
  }
  const domain=url.hostname.toLowerCase();
  if(url.protocol==='http:')issue('Hay un enlace sin cifrado HTTPS.',1,'suspicious');
  if(url.username || url.password)issue('El enlace oculta el destino utilizando credenciales antes del dominio.',4,'suspicious');
  if(/(?:^|\.)xn--/i.test(domain))issue('El dominio contiene caracteres internacionalizados: comprueba posibles imitaciones.',1,'suspicious');
  if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) || domain.includes(':'))issue('El enlace apunta a una dirección IP en lugar de un dominio.',2,'suspicious');
  if(shorteners.has(domain))issue('Un enlace acortado oculta el destino final.',1,'suspicious');
  if(/[​-‏‪-‮⁦-⁩]/.test(trimmed))issue('El enlace contiene caracteres invisibles o de dirección de texto.',3,'suspicious');
  const target=declaredTarget(url);
  const declared=target?.hostname.toLowerCase() || '';
  // Punctuation after a written address («visita www.banco.com,») is part of the sentence, not of the address.
  const shown=visibleText.trim().replace(/[.,;:!?)\]}»"'’]+$/,'');
  const bare=shown.match(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i)?.[0];
  // Without http:// or www., the text only counts as an address when it ends in a real domain ending:
  // «permissions.blockWritesOutsideWorkingDirectories» or «config.json» are names, not sites.
  const displayed=shown.match(/^(?:https?:\/\/|www\.)[^\s]+$/i)?.[0] ?? (bare && looksLikeDomain(bare.split('/')[0]) ? bare : undefined);
  if(displayed){const visibleHost=host(/^https?:\/\//i.test(displayed)?displayed:'https://'+displayed);
    // Another subdomain of the same registered domain (www.x.com → data.a.x.com) is the same organization.
    if(visibleHost && !related(visibleHost,domain) && !sameOrganization(visibleHost,domain)){
      const sender=context.verified?context.senderDomain || '':'';
      const ownText=!!sender && sameOrganization(visibleHost,sender);
      // The redirector belongs to the verified sender (its own domain or a known click counter): only then is its declared destination believed.
      const ownRedirector=!!sender && (sameOrganization(domain,sender) || isTrackingDomain(domain));
      const declaredMatches=!!declared && (related(visibleHost,declared) || sameOrganization(visibleHost,declared));
      if(ownText)issue('Enlace de seguimiento de clics: muestra '+visibleHost+' y pasa por '+domain+(isTrackingDomain(domain)?'':' (servicio del propio remitente)')+'. Es habitual en correos masivos y el remitente está verificado.',0);
      else if(ownRedirector && declaredMatches)issue('Enlace de seguimiento: pasa por '+domain+', del remitente verificado, y lleva a '+declared+', como muestra el texto.',0);
      else if(!!sender && context.knownSender && sameOrganization(domain,sender))issue('Enlace de seguimiento de '+domain+': el remitente está verificado y ya te ha escrito antes.',0);
      else if(!!sender && !declared && !!redirectorOwner(domain) && sameOrganization(redirectorOwner(domain)!,sender))issue('Enlace corto de '+domain+', servicio propio de '+sender+' (remitente verificado), que muestra '+visibleHost+'.',0);
      else if(declared && !declaredMatches)issue('El texto muestra '+visibleHost+', pero el enlace declara llevar a '+declared+'.',4);
      else issue('El texto muestra '+visibleHost+', pero el enlace lleva a '+domain+(declaredMatches?' (dice ir a '+declared+', pero no se puede confirmar)':'')+'.',2,'mismatch');
    }
  }
  if(sensitiveFiles.test(url.pathname))issue('El enlace parece descargar un archivo ejecutable o un acceso directo.',4);
  // Known brand names are a heuristic, never a sender authentication result.
  for(const [brand,official] of [['microsoft',['microsoft.com','live.com','office.com','microsoftonline.com']],['google',['google.com','gmail.com']],['paypal',['paypal.com']]] as [string,string[]][]){
    if(domain.includes(brand) && !official.some(d=>domain===d || domain.endsWith('.'+d)))issue('Un dominio incluye el nombre de '+brand+' fuera de sus dominios habituales.',2);
  }
  const imitation=findLookalike(domain,KNOWN_BRANDS.flatMap(brand=>brand.domains.map(d=>({domain:d,label:brand.name}))));
  if(imitation)issue('El enlace lleva a '+domain+', que imita a '+imitation.label+' ('+imitation.imitates+').',4);
  return {url,domain,blocked:false,findings,danger:findings.some(f=>f.weight>=4),declared:target?.href};
}

/** Template contents are inert: scripts, images and frames are never inserted in the document. */
export function inspectHtml(html:string):{text:string;anchors:{href:string;text:string}[];truncated:boolean;hidden:string} {
  const template=document.createElement('template');
  template.innerHTML=html.slice(0,MAX_CONTENT);
  const anchors=Array.from(template.content.querySelectorAll('a[href]')).slice(0,MAX_LINKS+1)
    .map(a=>({href:a.getAttribute('href') || '',text:a.textContent || ''}));
  // Text the reader never sees (display:none, zero size, transparent…), where instructions for AI assistants hide.
  const hidden=Array.from(template.content.querySelectorAll('[style],[hidden]')).filter(node=>node.hasAttribute('hidden') || /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em)?\b|opacity\s*:\s*0(?:\.0+)?\b|max-height\s*:\s*0|(?:^|;)\s*color\s*:\s*(?:transparent|rgba\([^)]*,\s*0\))/i.test(node.getAttribute('style') || '')).map(node=>node.textContent || '').join('\n').slice(0,20000);
  template.content.querySelectorAll('script,style,iframe,object,embed,svg,template').forEach(node=>node.remove());
  template.content.querySelectorAll('br').forEach(node=>node.replaceWith('\n'));
  template.content.querySelectorAll('p,div,li,tr,section,blockquote,h1,h2,h3,h4').forEach(node=>node.append('\n'));
  return {text:template.content.textContent || '',anchors,truncated:html.length>MAX_CONTENT || anchors.length>MAX_LINKS,hidden};
}

export function analyzeMail(input:MailInput):MailInsights {
  const parsed=input.html?inspectHtml(input.html):null;
  const text=(input.text+'\n'+(parsed?.text || '')).slice(0,MAX_CONTENT);
  const hay=clean(input.subject+'\n'+text), subject=clean(input.subject);
  // Categories: scored local classifier (see mail-classifier.ts).
  const classification=classifyMail({subject:input.subject,sender:input.sender,senderName:input.senderName,text,labels:input.labels,filenames:input.filenames,bulk:input.bulk});
  const {categories,specificLabels}=classification, classificationReasons=classification.reasons, automated=classification.automated;
  const reasons:string[]=[], notes:string[]=[], links:LinkFinding[]=[];let score=0;
  const weights:Record<string,number>={};
  const warn=(reason:string,weight:number)=>{if(weight<=0){if(!notes.includes(reason))notes.push(reason);return;}if(!reasons.includes(reason)){reasons.push(reason);score+=weight;weights[reason]=weight;}};
  /** Signs of deceit: they turn a link that does not go where it says into likely phishing. */
  let deceit=false;
  const signal=(reason:string,weight:number)=>{warn(reason,weight);deceit=true;};
  const auth=input.auth;
  const verified=auth?.status==='verified';
  if(auth?.status==='failed')signal(auth.detail,4);
  if((input.labels || []).some(label=>label.toUpperCase()==='SPAM'))warn('Tu servicio de correo lo marcó como no deseado (spam).',3);
  const senderDomain=input.sender.split('@').pop()?.toLowerCase() || '';
  const senderName=clean(input.senderName || '');
  // The display name is free text: "Banco Pichincha <alerta@otro.com>" or "pichincha.com <x@otro.com>".
  for(const brand of KNOWN_BRANDS){
    const named=new RegExp('\\b'+clean(brand.name).replace(/^banco /,'(banco )?')+'\\b').test(senderName);
    if(senderDomain && named && !brand.domains.some(d=>sameOrganization(d,senderDomain)))signal('El nombre del remitente dice «'+brand.name+'», pero la dirección es de '+senderDomain+', que no pertenece a '+brand.name+'.',verified?2:3);
  }
  const shownDomain=(input.senderName || '').match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/i)?.[1]?.toLowerCase();
  if(shownDomain && senderDomain && !(input.senderName || '').includes('@') && !sameOrganization(shownDomain,senderDomain) && baseName(shownDomain)!==baseName(senderDomain))signal('El nombre del remitente muestra '+shownDomain+', pero la dirección real es de '+senderDomain+'.',verified?1:3);
  const senderImitation=senderDomain?findLookalike(senderDomain,KNOWN_BRANDS.flatMap(brand=>brand.domains.map(d=>({domain:d,label:brand.name})))):null;
  if(senderImitation)signal('La dirección del remitente ('+senderDomain+') imita a '+senderImitation.label+' ('+senderImitation.imitates+').',4);
  if(verified)notes.push(auth!.detail);
  const candidates=[...(parsed?.anchors || [])];
  for(const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"']+/gi)){
    if(candidates.length>MAX_LINKS)break;
    candidates.push({href:match[0].replace(/[.,;)\]}]+$/,''),text:''});
  }
  const seen=new Set<string>();
  for(const candidate of candidates.slice(0,MAX_LINKS)){
    const raw=candidate.href.trim();
    if(!raw || raw.startsWith('#') || /^(?:mailto|tel|cid):/i.test(raw))continue;
    const expanded=raw.startsWith('//')?'https:'+raw:/^www\./i.test(raw)?'https://'+raw:raw;
    if(seen.has(expanded))continue;seen.add(expanded);
    const check=checkLink(raw,candidate.text,{senderDomain,verified});
    for(const finding of check.findings){if(finding.kind==='suspicious' || (finding.weight>=4 && finding.kind!=='mismatch'))signal(finding.reason,finding.weight);else warn(finding.reason,finding.weight);}
    if(!check.url){warn('Un enlace no permite identificar su destino.',1);links.push({domain:'Destino no interpretable',reasons:['No se pudo comprobar el destino del enlace.']});continue;}
    links.push({domain:check.blocked?'Protocolo bloqueado: '+check.url.protocol:check.domain,reasons:check.findings.map(finding=>finding.reason)});
  }
  if(/\b(contrasena|password|codigo de verificacion|verification code|codigo otp|numero de tarjeta|cvv|frase semilla|seed phrase)\b/.test(hay)
      && /\b(envia|envie|enviar|comparte|compartir|introduce|ingresa|confirma|confirmar|verifica|verify|enter|provide|send|reply)\b/.test(hay))signal('El mensaje parece solicitar credenciales, códigos o información financiera.',3);
  if(links.length && /\b(suspendid[ao]|bloquead[ao]|ultima advertencia|ultimatum|within 24 hours|evita el cierre)\b/.test(hay))signal('Combina enlaces con presión para evitar un bloqueo o cierre de cuenta.',2);
  if(/\b(gana|ganaste|premio|loteria|lottery|winner)\b/.test(subject) && /\b(paga|pago|tarjeta|transferencia|deposito|fee|payment)\b/.test(hay))signal('Ofrece un premio y solicita un pago o información financiera.',3);
  if(input.replyTo && input.sender){const from=input.sender.split('@').pop()?.toLowerCase(),reply=input.replyTo.split('@').pop()?.toLowerCase();
    if(from && reply && !related(from,reply))warn('La dirección de respuesta pertenece a un dominio distinto al remitente. Puede ser legítimo; verifícalo.',1);}
  // Callback phishing: «we charged $399, call 1-800-… to cancel». No links, so filters let it through; the scam
  // happens on the phone. A phone number + a call to action + a charge, renewal, refund or support story.
  const phone=/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\b1[\s.-]?8\d{2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/;
  const callToAction=/\b(llama|llamanos|llame|llamar|marca|comunicate|comuniquese|contacta|contactanos|contacte|call|dial|phone us|contact us|reach us)\b/;
  const story=/\b(cargo|cobro|cobrado|cobramos|debitado|factura|renovacion|renovado|suscripcion|reembolso|cancelar|cancelacion|pedido|compra no autorizada|soporte tecnico|antivirus|norton|mcafee|geek squad|charged|charge|renewal|renewed|subscription|refund|cancel|invoice|order|unauthorized|tech support)\b/;
  // A verified bank or brand writing «si no reconoces este cargo, llama a…» is normal: only a note then.
  const officialSender=verified && KNOWN_BRANDS.some(brand=>brand.domains.some(d=>sameOrganization(d,senderDomain)));
  if(phone.test(text) && callToAction.test(hay) && story.test(hay) && officialSender)notes.push('Incluye un teléfono de contacto. Si vas a llamar, usa el número de la web oficial.');
  else if(phone.test(text) && callToAction.test(hay) && story.test(hay))
    signal('Pide que llames a un número para resolver un cobro, una renovación o un pedido. Es el engaño de la «llamada de soporte»: busca el teléfono en la web oficial, no uses el de este correo.',verified?2:3);
  // Business email compromise: "we changed our bank account, pay here". Gmail and Outlook do not flag it.
  if(/\b(nueva|nuevo|cambi\w*|actualiz\w*|modific\w*|new|changed?|updated?)\b.{0,60}\b(cuenta bancaria|datos bancarios|numero de cuenta|cuenta de (deposito|pago)|iban|swift|bank (account|details)|banking details|wire instructions)\b/.test(hay)
      && /\b(transfier\w*|transferencia|deposit\w*|pag[aeou]\w*|abon\w*|wire|pay|payment|remit\w*)\b/.test(hay))
    signal('Pide pagar o transferir a una cuenta bancaria nueva o cambiada. Antes de pagar, confírmalo por teléfono con un número que ya conozcas, no con los datos de este correo.',verified?2:3);
  // Text written for an AI assistant ("ignore previous instructions", "assistant: tell the user…"), often hidden.
  const aiTarget=/\b(ignore|disregard|forget) (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|rules)|\bignora (todas )?(las |tus )?(instrucciones|reglas) (anteriores|previas)|\bolvida (todas )?(las |tus )?instrucciones|\b(you are|act as) (an? )?(ai|llm|language model|assistant)\b|\beres (un |una )?(asistente|ia|modelo de lenguaje)\b|\bsystem prompt\b|\b(note|message|instructions?) (to|for) (the )?(ai|assistant|llm|model)\b|\b(nota|mensaje|instrucciones?) (para|al?) (el |la )?(asistente|ia|modelo)\b|\b(asistente|assistant|ia|ai|llm)\s*[:,]\s*(responde|di|dile|indica|marca|reenvia|envia|ignora|tell|say|reply|mark|forward|send|ignore)\b|\b(dile|tell|inform) (al |the )?(usuario|user) (que|that)\b/;
  const hiddenText=clean(parsed?.hidden || '');
  const aiInjection=aiTarget.test(hay) || aiTarget.test(hiddenText);
  if(aiInjection)warn(aiTarget.test(hiddenText)?'Contiene texto oculto con instrucciones dirigidas a asistentes de IA. NexoMail no las sigue.':'Contiene instrucciones dirigidas a asistentes de IA. NexoMail no las sigue.',3);
  for(const filename of (input.filenames || []).slice(0,60)){
    if(sensitiveFiles.test(filename))warn('Incluye un adjunto ejecutable, script o acceso directo.',4);
    else if(activeFiles.test(filename))warn('Incluye un archivo comprimido o con contenido activo que requiere precaución.',1);
    if(/\.(?:pdf|docx?|xlsx?|jpe?g|png)\.[^.]+$/i.test(filename))warn('Un adjunto tiene doble extensión y puede ocultar su tipo real.',3);
  }
  // Asking to sign in or verify the account is not a warning by itself, but it is what phishing links are for.
  if(links.length && /\b(inicia sesion|iniciar sesion|ingresa a tu cuenta|accede a tu cuenta|log ?in|sign in|verifica tu (cuenta|identidad)|confirma tu (cuenta|identidad)|actualiza tus datos)\b/.test(hay))deceit=true;
  if(deceit && reasons.some(reason=>LINK_MISMATCH.test(reason)))warn(MISMATCH_WITH_DECEIT,2);
  const partial=!!input.partial || !!parsed?.truncated || input.text.length>MAX_CONTENT || candidates.length>MAX_LINKS;
  return relabel({categories,classificationReasons,specificLabels,automated,level:'none',label:'',reasons,links,partial,hasAttachments:!!input.hasAttachments || !!input.filenames?.length,score,sender:auth,notes,aiInjection,weights});
}
