import { messageStamp } from './dates';
import { analyzeMail, inspectHtml, ownMessageInsights } from '@shared/mail/mail-insights';
import { senderAuthentication } from '@shared/mail/sender-intel';
import { hasLinks, toHtml, toPlainText } from './mailLinks';
import { toEmailHtml } from './richText';
import type { OutgoingExtra } from './mailProvider';
import type { Email , MailFile, MailAttachment} from '../types/email';
import { base64ToBlob } from './mailFiles';
import { MANUAL_CATEGORIES } from '../types/email';
import { cleanMessageBody } from './mailIntent';

import { MAX_ATTACHMENT_BYTES } from './platform';

export type GmailConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  sessionId?: string;
};

const GMAIL_CONFIG_KEY = 'emailagent.extension.gmail.session';

/**
 * Gmail measures each account's usage over a moving one-second window (about 250 units) and per
 * minute. Requests are paced below both, so a large first load spreads over a few seconds instead
 * of being refused. Costs follow Gmail's quota table.
 */
const UNITS_PER_SECOND = 180;
const UNITS_PER_MINUTE = 12000;
function gmailCost(url: string, method: string): number {
  if (/\/messages\/send/.test(url)) return 100;
  if (/\/labels(?:\?|$)/.test(url)) return method === 'GET' ? 1 : 5;
  return 5;
}
class GmailPacer {
  private spent: { at: number; units: number }[] = [];
  /** When Gmail asks to wait, every request waits together instead of each one insisting (which prolongs the limit). */
  private pausedUntil = 0;
  pause(ms: number): void { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
  async take(units: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) { await new Promise((resolve) => setTimeout(resolve, this.pausedUntil - now)); continue; }
      this.spent = this.spent.filter((entry) => now - entry.at < 60_000);
      const lastSecond = this.spent.filter((entry) => now - entry.at < 1000).reduce((sum, entry) => sum + entry.units, 0);
      const lastMinute = this.spent.reduce((sum, entry) => sum + entry.units, 0);
      if (lastSecond + units <= UNITS_PER_SECOND && lastMinute + units <= UNITS_PER_MINUTE) { this.spent.push({ at: now, units }); return; }
      // Wait until enough of the window has passed.
      const wait = lastMinute + units > UNITS_PER_MINUTE ? 1000 : 120;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  /** Units used in the last minute, to show or log. */
  usedLastMinute(): number { const now = Date.now(); return this.spent.filter((entry) => now - entry.at < 60_000).reduce((sum, entry) => sum + entry.units, 0); }
}
export const gmailPacer = new GmailPacer();

/**
 * Gmail also limits how many requests of one account run at the same time («Too many concurrent requests for
 * user»). Loading the inbox, the sent folder and checking for news at once went over it; now at most 4 run together.
 */
class Slots {
  private free: number;
  private waiting: (() => void)[] = [];
  constructor(size: number) { this.free = size; }
  acquire(): Promise<void> { if (this.free > 0) { this.free--; return Promise.resolve(); } return new Promise(resolve => this.waiting.push(resolve)); }
  release(): void { const next = this.waiting.shift(); if (next) next(); else this.free++; }
}
const gmailSlots = new Slots(4);

/** Gmail answers 429, or 403 with one of these reasons, when the per-minute quota of the account is used up. */
const LIMIT_REASON = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|Quota exceeded/i;
export const GMAIL_LIMIT_MESSAGE = 'Gmail limitó temporalmente las peticiones de tu cuenta. Espera un minuto y vuelve a intentarlo; no se hizo ningún cambio.';
/** A message already downloaded is reused for this long; changes made by NexoMail refresh it at once. */
const DETAIL_TTL_MS = 10 * 60 * 1000;
const DETAIL_CACHE_MAX = 600;

export class RealGmailProvider {
  private config: GmailConfig | null = null;
  private isLiveMode: boolean = false;
  private detailCache = new Map<string, { at: number; email: Email }>();
  /** A message being downloaded is shared by loads that overlap (inbox refresh and the agent at once). */
  private inflight = new Map<string, Promise<Email | null>>();
  private cacheSession = '';
  private cachedEmail(id: string): Email | null {
    if (this.cacheSession !== this.getSessionKey()) { this.detailCache.clear(); this.cacheSession = this.getSessionKey(); }
    const hit = this.detailCache.get(id);
    return hit && Date.now() - hit.at < DETAIL_TTL_MS ? hit.email : null;
  }
  private remember(email: Email): void {
    this.detailCache.delete(email.id);
    this.detailCache.set(email.id, { at: Date.now(), email });
    while (this.detailCache.size > DETAIL_CACHE_MAX) this.detailCache.delete(this.detailCache.keys().next().value!);
  }
  /** Messages NexoMail just changed are downloaded again next time, so their state is never stale. */
  private forget(ids: string[]): void { for (const id of ids) this.detailCache.delete(id); }

  constructor() {
    this.loadSavedConfig();
  }

  public loadSavedConfig(): boolean {
    try {
      const saved = sessionStorage.getItem(GMAIL_CONFIG_KEY) || localStorage.getItem(GMAIL_CONFIG_KEY);
      if (saved) {
        this.config = JSON.parse(saved);
        if (this.config?.accessToken || this.config?.sessionId) {
          this.isLiveMode = true;
          return true;
        }
      }
    } catch (e) {
      console.error('Error cargando configuración guardada de Gmail:', e);
    }
    return false;
  }

  public saveConfig(config: GmailConfig) {
    const cleanToken = config.accessToken ? config.accessToken.replace(/^Bearer\s+/i, '').trim() : undefined;
    this.config = { ...config, accessToken: cleanToken };
    if (cleanToken || config.sessionId) {
      this.isLiveMode = true;
    }
    try {
      const payload = JSON.stringify(this.config);
      sessionStorage.setItem(GMAIL_CONFIG_KEY, payload);
      localStorage.setItem(GMAIL_CONFIG_KEY, payload);
    } catch {}
  }

  public clearConfig() {
    this.config = null;
    this.isLiveMode = false;
    sessionStorage.removeItem(GMAIL_CONFIG_KEY);
    localStorage.removeItem(GMAIL_CONFIG_KEY);
  }

  public isConnected(): boolean {
    return this.isLiveMode && !!this.config?.sessionId;
  }

  public getSessionKey(): string {return this.isConnected() ? 'gmail:'+(window.emailAgentHost.googleSessionId() || 'disconnected') : 'gmail:simulated';}
  public accountEmail(): string { return this.config?.email || ''; }
  /** Same steps the app used before: the Client ID comes from the extension options. */
  public async connect(override?: string): Promise<void> {
    await window.emailAgentHost.ready;
    const clientId=(override || window.emailAgentHost.config.googleClientId)?.trim();
    if(!clientId){await window.emailAgentHost.openOptions();throw new Error('Falta configurar Google en las opciones de la extensión.');}
    const auth=await window.emailAgentHost.googleLogin(clientId);
    this.saveConfig({...auth,clientSecret:'',redirectUri:''});
  }
  public async disconnect(): Promise<void> {
    await window.emailAgentHost.googleDisconnect();
    this.clearConfig();
  }
  public getConfig(): GmailConfig | null {
    return this.config;
  }

  public async restoreSession():Promise<void> {
    const auth=await window.emailAgentHost.googleRestore();
    if(auth)this.saveConfig({...auth,clientSecret:'',redirectUri:''});
    else this.clearConfig();
  }
  public storageAccessToken():Promise<string>{return this.accessToken();}
  /**
   * Another NexoMail panel (another Gmail tab, or this one after reloading the extension) can renew the Google
   * session of the same account, which retires the session this panel holds. Adopt the current one, but only if it
   * is the same account; anything else still fails.
   */
  private async adoptRenewedSession():Promise<boolean>{
    const email=(this.config?.email || '').toLowerCase();
    if(!email)return false;
    const auth=await window.emailAgentHost.googleRestore().catch(()=>null);
    if(!auth?.sessionId || (auth.email || '').toLowerCase()!==email)return false;
    this.saveConfig({...auth,clientSecret:'',redirectUri:''});
    return true;
  }
  private async accessToken():Promise<string> {
    let session=this.config?.sessionId;
    if(!session)throw new Error('Conecta Gmail mediante el botón de Google.');
    let token:string;
    try{token=await window.emailAgentHost.googleAccessToken(session);}
    catch(error){
      if(!/cuenta de la página cambió/i.test(error instanceof Error?error.message:'') || !(await this.adoptRenewedSession()))throw error;
      session=this.config!.sessionId!;
      token=await window.emailAgentHost.googleAccessToken(session);
    }
    if(this.config?.sessionId!==session)throw new Error('La cuenta cambió durante la autorización.');
    this.config={...this.config,accessToken:token};
    return token;
  }
  private async gmailRequest(url:string,options:RequestInit={}):Promise<Response> {
    const session=this.config?.sessionId;
    const headers=new Headers(options.headers);
    if(options.method && options.method!=='GET' && session){
      // Refresh before the first write attempt, including writes following a read.
      const token=await window.emailAgentHost.googleAccessToken(session);
      if(this.config?.sessionId!==session)throw new Error('La cuenta cambió antes de ejecutar la acción.');
      headers.set('Authorization','Bearer '+token);
      options={...options,headers};
    }
    // Every call waits its turn so the account stays under Gmail's per-second and per-minute limits.
    const cost=gmailCost(url,options.method || 'GET');
    const send=async(init:RequestInit)=>{
      await gmailSlots.acquire();
      try{await gmailPacer.take(cost);return await fetch(url,{...init,signal:init.signal ?? AbortSignal.timeout(45000)});}
      finally{gmailSlots.release();}
    };
    let response=await send(options);
    // Only reads are replayed, once. A write is never repeated automatically.
    if(response.status===401 && (!options.method || options.method==='GET') && session){
      await window.emailAgentHost.googleInvalidateToken((headers.get('Authorization') || '').replace(/^Bearer /,''));
      const token=await window.emailAgentHost.googleAccessToken(session);
      if(this.config?.sessionId!==session)throw new Error('La sesión cambió. Vuelve a seleccionar el correo.');
      headers.set('Authorization','Bearer '+token);
      response=await send({...options,headers});
    }
    // Gmail limits requests per user; a read over the limit waits (what Gmail asks, or 2, 5 and 10 s) and tries again.
    const overLimit=async(res:Response)=>res.status===429 || (res.status===403 && LIMIT_REASON.test(await res.clone().text()));
    for(let attempt=1;attempt<=3 && (!options.method || options.method==='GET') && await overLimit(response);attempt++){
      const asked=Number(response.headers.get('Retry-After'));
      const wait=Number.isFinite(asked) && asked>0 ? Math.min(asked,20)*1000 : [2000,5000,10000][attempt-1];
      // Only the reason Gmail gives is logged, never the token or the content.
      console.warn('Gmail limitó una lectura (HTTP '+response.status+'): '+((await response.clone().text()).match(/"reason":\s*"([^"]+)"/)?.[1] || 'sin motivo')+'. Reintento '+attempt+' en '+Math.round(wait/1000)+' s. Unidades usadas por NexoMail en el último minuto: '+gmailPacer.usedLastMinute()+'.');
      gmailPacer.pause(wait);
      await new Promise(resolve=>setTimeout(resolve,wait));
      response=await send({...options,headers});
    }
    if(await overLimit(response))throw new Error(GMAIL_LIMIT_MESSAGE);
    return response;
  }

  // Real Gmail API call to list messages
  private labelNames: {session:string;names:Map<string,string>}|null=null;

  /** Gmail returns label ids; manual categories are user labels, so their names are looked up once per session. */
  private async userLabelNames(token:string):Promise<Map<string,string>>{
    const session=this.getSessionKey();
    if(this.labelNames?.session===session)return this.labelNames.names;
    const res=await this.gmailRequest('https://gmail.googleapis.com/gmail/v1/users/me/labels',{headers:{Authorization:`Bearer ${token}`}});
    const names=new Map<string,string>();
    if(res.ok){const data=(await res.json()) as {labels?:Array<{id:string;name:string;type?:string}>};for(const label of data.labels || [])if(label.type!=='system')names.set(label.id,label.name);}
    this.labelNames={session,names};
    return names;
  }

  public async fetchEmails(query: string = 'in:inbox', maxResults: number = 10): Promise<Email[]> {
    if (!this.config?.sessionId) {
      throw new Error('No hay una sesión activa de Gmail API. Por favor conecta tu cuenta.');
    }

    const token=await this.accessToken();
    const labelNames=await this.userLabelNames(token).catch(()=>new Map<string,string>());
    try {
      // 1. List message IDs
      // Spam and trash are only listed when asked for explicitly (in:spam, in:trash).
      const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}${/\bin:(spam|trash)\b/.test(query) ? '&includeSpamTrash=true' : ''}`;
      const listRes = await this.gmailRequest(listUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!listRes.ok) {
        const errData = await listRes.json();
        throw new Error(errData.error?.message || 'Error al obtener lista de correos de Gmail API');
      }

      const listData = await listRes.json();
      if (!listData.messages || listData.messages.length === 0) {
        return [];
      }

      // 2. Details: listing costs 5 units, each message 5 more. Messages already downloaded are reused,
      // so a refresh or "Cargar más" only downloads the new ones, 10 at a time.
      const detail = async (item: { id: string }) => {
          const known = this.cachedEmail(item.id);
          if (known) return known;
          const pending = this.inflight.get(item.id);
          if (pending) return pending;
          const download = (async () => {
          const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`;
          const msgRes = await this.gmailRequest(msgUrl, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!msgRes.ok) return null;
          const msg = await msgRes.json();
          const email = this.parseGmailMessage(msg,labelNames);
          this.remember(email);
          return email;
          })();
          this.inflight.set(item.id, download);
          try { return await download; } finally { this.inflight.delete(item.id); }
      };
      const emails: (Email | null)[] = [];
      for (let i = 0; i < listData.messages.length; i += 10) emails.push(...await Promise.all(listData.messages.slice(i, i + 10).map(detail)));

      return emails.filter((e): e is Email => e !== null);
    } catch (err: any) {
      console.error('Error en fetchEmails de Gmail API:', err);
      throw err;
    }
  }

  // Parse Gmail API JSON object to our Email domain model
  private parseGmailMessage(msg: any,labelNames:Map<string,string>=new Map()): Email {
    const headers = msg.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const fromHeader = getHeader('From');
    const subject = getHeader('Subject') || '(Sin asunto)';
    const dateStr = getHeader('Date');
    
    // Extract Sender Name and Email Address
    let senderName = fromHeader;
    let senderEmail = fromHeader;
    const match = fromHeader.match(/^(.*?)\s*<(.*?)>$/);
    if (match) {
      senderName = match[1].replace(/^"|"$/g, '').trim() || match[2];
      senderEmail = match[2];
    }

    // Walk nested MIME alternatives, retaining hidden HTML destinations for analysis.
    const texts:string[]=[],htmls:string[]=[],filenames:string[]=[];
    const attachments:MailAttachment[]=[];
    let count=0,partial=false,remaining=500000;
    const walk=(part:any,depth=0):void=>{
      if(!part || depth>12 || ++count>80){partial=true;return;}
      // Images inside the text carry a Content-ID (the HTML points to them with cid:); some come without a file name.
      const contentId=String((part.headers || []).find((h:any)=>/^content-id$/i.test(h.name))?.value || '').replace(/^<|>$/g,'').trim();
      if(part.filename || (contentId && /^image\//i.test(part.mimeType || ''))){
        const name=String(part.filename || `imagen.${String(part.mimeType).split('/')[1] || 'png'}`);
        filenames.push(name);
        attachments.push({id:String(part.body?.attachmentId || `part-${count}`),name,type:String(part.mimeType || 'application/octet-stream'),size:Number(part.body?.size) || 0,data:part.body?.attachmentId?undefined:part.body?.data,...(contentId?{cid:contentId}:{})});
        return;
      }
      if(part.body?.data && ['text/plain','text/html'].includes(part.mimeType)){
        const encoded=String(part.body.data);
        if(encoded.length>800000){partial=true;return;}
        let decoded='';
        try{decoded=this.decodeBase64Url(encoded);}catch{partial=true;return;}
        if(decoded.length>remaining)partial=true;
        (part.mimeType==='text/html'?htmls:texts).push(decoded.slice(0,remaining));
        remaining=Math.max(0,remaining-decoded.length);
      }else if(part.body?.attachmentId && ['text/plain','text/html'].includes(part.mimeType))partial=true;
      for(const child of (part.parts || []).slice(0,80))walk(child,depth+1);
      if(part.parts?.length>80)partial=true;
    };
    walk(msg.payload);
    const html=htmls.join('\n'),plain=texts.join('\n');
    const body=plain || (html?inspectHtml(html).text:'') || msg.snippet || '';
    partial=partial || (!plain && !html);
    // Gmail writes its SPF/DKIM/DMARC verdict in the topmost Authentication-Results header.
    const auth=senderAuthentication(headers.map((h:any)=>({name:String(h.name || ''),value:String(h.value || '')})),senderEmail);
    // Mailing lists announce themselves in their headers: those messages are never personal mail.
    const bulk=headers.some((h:any)=>/^(list-unsubscribe|list-id)$/i.test(String(h.name || '')) || (/^precedence$/i.test(String(h.name || '')) && /bulk|list|junk/i.test(String(h.value || ''))));
    const insights=analyzeMail({subject,sender:senderEmail,senderName,text:body,html,auth,bulk,
      labels:msg.labelIds || [],filenames,replyTo:getHeader('Reply-To').match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1],partial});
    // What this account really sent (Gmail labels it SENT) is not checked as possible fraud. The From address alone
    // is not enough: some scams forge your own address as the sender.
    const own=(msg.labelIds || []).includes('SENT');
    const isUnread=msg.labelIds?.includes('UNREAD') ?? false;
    const isUrgent=insights.categories.includes('Importante');

    return {
      id: msg.id,
      threadId: msg.threadId || undefined,
      sender: senderEmail,
      senderName: senderName,
      senderAvatar: undefined,
      recipient: getHeader('To') || 'me',
      subject: subject,
      snippet: msg.snippet || '',
      body: body,
      bodyHtml: html || undefined,
      date: messageStamp(new Date(parseInt(msg.internalDate || '', 10) || Date.parse(dateStr || '') || Date.now())),
      timestamp: parseInt(msg.internalDate || Date.now().toString(), 10),
      read: !isUnread,
      // Gmail's «Principal» tab (CATEGORY_PERSONAL) holds almost all mail, so it is not read as «Personal».
      category: msg.labelIds?.includes('CATEGORY_PROMOTIONS') ? 'Boletines' : msg.labelIds?.includes('IMPORTANT') ? 'Importante' : 'Sin clasificar',
      insights: own ? ownMessageInsights(insights) : insights,
      priority: isUrgent ? 'urgent' : 'normal',
      labels: msg.labelIds || [],
      manualCategories: (msg.labelIds || []).map((id:string)=>labelNames.get(id)).filter((name:string|undefined):name is string=>!!name && (MANUAL_CATEGORIES as readonly string[]).includes(name)),
      trashed: (msg.labelIds || []).includes('TRASH'),
      attachments,
      hasAttachments: attachments.length > 0
    };
  }

  // Real Gmail API call to Trash emails
  public async trashEmails(ids: string[]): Promise<void> {
    this.forget(ids);
    if (!this.config?.sessionId) throw new Error('Sesión no autorizada');

    const token=await this.accessToken(),session=this.getSessionKey();
    await this.eachMessage(ids, 'mover', async (id) => {
      if(session!==this.getSessionKey())throw new Error('La sesión cambió. Se detuvo el resto de la operación.');
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`;
      const res = await this.gmailRequest(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        throw new Error('Gmail no confirmó el movimiento a la papelera. Revisa el buzón antes de crear otra propuesta.');
      }
    });
  }

  /** Runs a change message by message; if Gmail's limit stops it halfway, says how many were already done. */
  private async eachMessage(ids: string[], verb: string, step: (id: string) => Promise<void>): Promise<void> {
    let done = 0;
    for (const id of ids) {
      try { await step(id); }
      catch (error) {
        if (done > 0 && (error as Error).message === GMAIL_LIMIT_MESSAGE) {
          throw new Error(`Gmail limitó temporalmente las peticiones después de ${verb} ${done} de ${ids.length} correos. Espera un minuto y vuelve a aprobarla: los ya procesados no cambian.`);
        }
        throw error;
      }
      done++;
    }
  }

  public async untrashEmails(ids: string[]): Promise<void> {
    this.forget(ids);
    if (!this.config?.sessionId) throw new Error('Sesión no autorizada');
    const token=await this.accessToken(),session=this.getSessionKey();
    await this.eachMessage(ids, 'recuperar', async (id) => {
      if(session!==this.getSessionKey())throw new Error('La sesión cambió. Se detuvo el resto de la operación.');
      const res = await this.gmailRequest(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/untrash`, {method: 'POST',headers: { Authorization: `Bearer ${token}` }});
      if (!res.ok) throw new Error('Gmail no confirmó la recuperación. Revisa la papelera antes de volver a intentarlo.');
    });
  }

  /** Gmail's historyId changes with every change in the mailbox; reading it costs 1 unit of quota. */
  public async changeMarker(): Promise<string> {
    if (!this.config?.sessionId) return '';
    const token=await this.accessToken();
    const res=await this.gmailRequest('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token}`}});
    if(!res.ok)return '';
    const data=await res.json() as {historyId?:string;messagesTotal?:number};
    return `${data.historyId ?? ''}:${data.messagesTotal ?? ''}`;
  }

  public async markSpamEmails(ids: string[]): Promise<void> {
    this.forget(ids);
    if (!this.config?.sessionId) throw new Error('Sesión no autorizada');
    const token=await this.accessToken(),session=this.getSessionKey();
    await this.eachMessage(ids, 'mover a spam', async (id) => {
      if(session!==this.getSessionKey())throw new Error('La sesión cambió. Se detuvo el resto de la operación.');
      const res = await this.gmailRequest(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({addLabelIds:['SPAM'],removeLabelIds:['INBOX']})});
      if (!res.ok) throw new Error('Gmail no confirmó el movimiento a Spam. Revisa la bandeja antes de volver a intentarlo.');
    });
  }

  public async notSpamEmails(ids: string[]): Promise<void> {
    this.forget(ids);
    if (!this.config?.sessionId) throw new Error('Sesión no autorizada');
    const token=await this.accessToken(),session=this.getSessionKey();
    await this.eachMessage(ids, 'mover a la bandeja de entrada', async (id) => {
      if(session!==this.getSessionKey())throw new Error('La sesión cambió. Se detuvo el resto de la operación.');
      const res = await this.gmailRequest(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({removeLabelIds:['SPAM'],addLabelIds:['INBOX']})});
      if (!res.ok) throw new Error('Gmail no confirmó el cambio. Revisa la carpeta Spam antes de volver a intentarlo.');
    });
  }

  public async removeLabel(ids: string[], labelName: string): Promise<void> {
    this.forget(ids);
    if (!this.config?.sessionId) throw new Error('Sesión no autorizada');
    const token=await this.accessToken();
    const names=await this.userLabelNames(token);
    const labelId=[...names.entries()].find(([,name])=>name.toLowerCase()===labelName.toLowerCase())?.[0];
    if(!labelId)return;
    for (const id of ids) {
      const res = await this.gmailRequest(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({removeLabelIds:[labelId]})});
      if (!res.ok) throw new Error('Gmail no confirmó el cambio de clasificación.');
    }
  }

  // Real Gmail API call to Send email
  public async sendEmail(recipient: string, subject: string, body: string, attachments: MailFile[] = [], extra: OutgoingExtra = {}): Promise<void> {
    if (!this.config?.sessionId) throw new Error('Sesión no autorizada');
    body = cleanMessageBody(body);
    // Formatting, links with their own text, copies or attachments: the MIME builder (plain text + HTML alternatives).
    if (attachments.length || hasLinks(body) || extra.html || extra.cc || extra.bcc) return this.sendWithAttachments(recipient, subject, body, attachments, extra);

    const token=await this.accessToken();
    if(!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(recipient) || /[\r\n]/.test(subject)) throw new Error('Revisa el destinatario y el asunto.');
    const emailContent = [
      `To: ${recipient}`,
      `Subject: =?utf-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body
    ].join('\r\n');

    const raw = this.encodeBase64Url(emailContent);

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`;
    const res = await this.gmailRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Error al enviar correo mediante Gmail API');
    }
  }

  /**
   * Multipart message through Gmail's upload endpoint, which accepts messages up to 35 MB:
   * mixed [ alternative [ text, related [ html, images in the text ] ], attachments ]. Cc and Bcc go in the
   * headers; Gmail delivers Bcc and removes that header from what the recipients see.
   */
  private async sendWithAttachments(recipient: string, subject: string, body: string, attachments: MailFile[], extra: OutgoingExtra = {}): Promise<void> {
    const token=await this.accessToken();
    const list=(value?:string)=>(value ?? '').split(/[;,]/).map(part=>part.trim()).filter(Boolean);
    const valid=(address:string)=>/^[^\s<>@,;\r\n"]+@[^\s<>@,;\r\n"]+\.[^\s<>@,;\r\n"]+$/.test(address);
    const to=list(recipient),cc=list(extra.cc),bcc=list(extra.bcc);
    if(!to.length || [...to,...cc,...bcc].some(address=>!valid(address)) || /[\r\n]/.test(subject)) throw new Error('Revisa los destinatarios y el asunto.');
    const total=attachments.reduce((sum,file)=>sum+file.size,0);
    if(total>MAX_ATTACHMENT_BYTES) throw new Error('Los adjuntos superan el límite de 20 MB por mensaje.');
    const boundary='nexomail-'+crypto.randomUUID();
    const encodeWord=(text:string)=>`=?utf-8?B?${btoa(unescape(encodeURIComponent(text)))}?=`;
    const wrap=(value:string)=>value.replace(/.{1,76}/g,'$&\r\n');
    const b64=(text:string)=>wrap(btoa(unescape(encodeURIComponent(text))));
    const safeType=(type:string)=>/^[\w.+-]+\/[\w.+-]+$/.test(type)?type:'application/octet-stream';
    const inline=attachments.filter(file=>file.inline && file.cid && /^[\w.@-]+$/.test(file.cid));
    const regular=attachments.filter(file=>!inline.includes(file));
    const html=extra.html ? toEmailHtml(extra.html) : hasLinks(body) ? toHtml(body) : '';
    const text=extra.html ? body : hasLinks(body) ? toPlainText(body) : body;
    const htmlPart=inline.length
      ? [`Content-Type: multipart/related; boundary="${boundary}-rel"`,'',
        `--${boundary}-rel`,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',b64(html),
        ...inline.flatMap(file=>[`--${boundary}-rel`,`Content-Type: ${safeType(file.type)}; name="${file.name.replace(/[\r\n"\\]/g,'_')}"`,'Content-Transfer-Encoding: base64',`Content-ID: <${file.cid}>`,`Content-Disposition: inline; filename="${file.name.replace(/[\r\n"\\]/g,'_')}"`,'',wrap(file.data)]),
        `--${boundary}-rel--`]
      : ['Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',b64(html)];
    const bodyPart=html
      ? [`Content-Type: multipart/alternative; boundary="${boundary}-alt"`,'',
        `--${boundary}-alt`,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',b64(text),
        `--${boundary}-alt`,...htmlPart,
        `--${boundary}-alt--`]
      : ['Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',b64(text)];
    const parts=[
      `To: ${to.join(', ')}`,...(cc.length?[`Cc: ${cc.join(', ')}`]:[]),...(bcc.length?[`Bcc: ${bcc.join(', ')}`]:[]),
      `Subject: ${encodeWord(subject)}`,'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',
      `--${boundary}`,...bodyPart,
      ...regular.flatMap(file=>{const name=file.name.replace(/[\r\n"\\]/g,'_');return [`--${boundary}`,`Content-Type: ${safeType(file.type)}; name="${encodeWord(name)}"`,`Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(name)}`,'Content-Transfer-Encoding: base64','',wrap(file.data)];}),
      `--${boundary}--`,''
    ].join('\r\n');
    const res=await this.gmailRequest('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'message/rfc822'},body:parts});
    if(!res.ok){const err=await res.json().catch(()=>({}));throw new Error(err.error?.message || 'Gmail no aceptó el mensaje con adjuntos.');}
  }

  public async labelEmails(ids: string[], labelName: string): Promise<void> {
    this.forget(ids);
    if (!this.config?.sessionId) throw new Error('Sesión no autorizada');

    const token=await this.accessToken(),session=this.getSessionKey();
    const labelId = await this.ensureUserLabel(labelName,token);
    this.labelNames=null;
    if(session!==this.getSessionKey())throw new Error('La sesión cambió. Se detuvo el etiquetado.');

    await Promise.all(
      ids.map(async (id) => {
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`;
        const res = await this.gmailRequest(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ addLabelIds: [labelId] }),
        });
        if (!res.ok) {
          throw new Error('Gmail rechazó una etiqueta. Algunas anteriores pueden haberse aplicado; actualiza antes de volver a intentar.');
        }
      })
    );
  }

  private async ensureUserLabel(name: string,token:string): Promise<string> {
    const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/labels';
    const listRes = await this.gmailRequest(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (listRes.ok) {
      const data = (await listRes.json()) as { labels?: Array<{ id: string; name: string }> };
      const existing = data.labels?.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing.id;
    }

    const createRes = await this.gmailRequest(listUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    });
    if (!createRes.ok) {
      throw new Error('No se pudo crear la etiqueta en Gmail');
    }
    const created = (await createRes.json()) as { id: string };
    return created.id;
  }

  // Real Gmail API call to Mark as Read
  public async listAttachments(email: Email): Promise<MailAttachment[]> { return email.attachments ?? []; }

  /** Downloads one attachment, only when the person asks to view or save it (5 quota units). */
  public async downloadAttachment(email: Email, attachment: MailAttachment): Promise<Blob> {
    let data = attachment.data;
    if (!data) {
      const token = await this.accessToken();
      const res = await this.gmailRequest(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(email.id)}/attachments/${encodeURIComponent(attachment.id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Gmail no entregó el adjunto. Vuelve a intentarlo.');
      data = String((await res.json()).data ?? '');
    }
    return base64ToBlob(data, attachment.type);
  }

  public async markAsRead(id: string): Promise<void> {
    this.forget([id]);
    if (!this.config?.sessionId) return;

    const token=await this.accessToken();
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`;
    const response=await this.gmailRequest(url, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({removeLabelIds:['UNREAD']})});
    if(!response.ok)throw new Error('Gmail no pudo actualizar el estado de lectura.');
  }

  private decodeBase64Url(input: string): string {
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    try {
      return decodeURIComponent(escape(atob(base64)));
    } catch (e) {
      return atob(base64);
    }
  }

  private encodeBase64Url(input: string): string {
    return btoa(unescape(encodeURIComponent(input)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
}

export const realGmailProvider = new RealGmailProvider();
