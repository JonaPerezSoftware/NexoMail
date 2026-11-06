import { PublicClientApplication, BrowserCacheLocation, LogLevel, EventType, InteractionRequiredAuthError, type AccountInfo, type AuthenticationResult } from '@azure/msal-browser';
import { analyzeMail, inspectHtml } from '@shared/mail/mail-insights';
import type { Email, EmailCategory, MailAttachment, MailFile } from '../types/email';
import { base64ToBlob } from './mailFiles';
import { MANUAL_CATEGORIES } from '../types/email';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL, MAX_LOADED } from './platform';
import { describeMicrosoftError } from './microsoftError';
import { cleanMessageBody } from './mailIntent';
import { captureSession, hydrateSession } from './microsoftSessionCache';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const READ_SCOPES = ['User.Read', 'Mail.Read'];
const WRITE_SCOPES = ['Mail.ReadWrite'];
const SEND_SCOPES = ['Mail.Send'];
const SELECT = 'id,subject,from,receivedDateTime,isRead,bodyPreview,body,categories,parentFolderId,flag,isDraft,hasAttachments,toRecipients,replyTo,importance';
/** Gmail-style folder names used by the shared interface, mapped to Outlook's well-known folders. */
const FOLDERS: Record<string, string> = { inbox: 'inbox', sent: 'sentitems', trash: 'deleteditems', drafts: 'drafts', spam: 'junkemail' };
const CATEGORIES: EmailCategory[] = ['Trabajo', 'Finanzas', 'Urgente', 'Suscripciones', 'Personal', 'Notificaciones', 'Importante', 'Boletines'];

type GraphAddress = { emailAddress: { name?: string; address?: string } };
type GraphMessage = {
  id: string; subject?: string; from?: GraphAddress; receivedDateTime: string; isRead?: boolean; bodyPreview?: string;
  body?: { contentType: string; content: string }; categories?: string[]; parentFolderId?: string; flag?: { flagStatus?: string };
  hasAttachments?: boolean; toRecipients?: GraphAddress[]; replyTo?: GraphAddress[]; importance?: string;
};
type Mode = 'read' | 'write' | 'send';

export const OUTLOOK_LIMIT_MESSAGE = 'Outlook limitó temporalmente las peticiones de tu cuenta. Espera un minuto y vuelve a intentarlo; no se hizo ningún cambio.';

/**
 * Graph throttles a mailbox that receives more than 4 requests at the same time.
 * Every call takes one of 3 slots, so overlapping loads (inbox, folders, agent) wait their turn.
 */
class Slots {
  private free: number;
  private waiting: (() => void)[] = [];
  constructor(size: number) { this.free = size; }
  acquire(): Promise<void> {
    if (this.free > 0) { this.free--; return Promise.resolve(); }
    return new Promise(resolve => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.free++;
  }
}
const graphSlots = new Slots(3);

/** Gmail search syntax (as built by the shared agent) translated to Outlook KQL. */
function toKql(query: string): string {
  return query
    .replace(/(\w+):"([^"]*)"/g, (_, field: string, phrase: string) => phrase.split(/\s+/).filter(Boolean).map(word => `${field}:${word}`).join(' '))
    .replace(/\{([^}]*)\}/g, (_, group: string) => `(${group.trim().split(/\s+/).join(' OR ')})`)
    .replace(/"/g, '')
    .trim();
}

export class OutlookProvider {
  private client: PublicClientApplication | null = null;
  private account: AccountInfo | null = null;
  private flowPending = false;
  private folderIds: { key: string; ids: Record<string, string> } | null = null;

  private clientId(): string { return window.emailAgentHost.config.microsoftClientId?.trim() || ''; }
  private async pca(): Promise<PublicClientApplication> {
    if (this.client) return this.client;
    const cfg = window.emailAgentHost.config;
    const tenant = ['consumers', 'common', 'organizations'].includes(cfg.microsoftTenant || '') ? cfg.microsoftTenant : 'common';
    const redirectUri = window.emailAgentHost.microsoftRedirect();
    const client = new PublicClientApplication({
      auth: { clientId: this.clientId(), authority: 'https://login.microsoftonline.com/' + tenant, redirectUri, postLogoutRedirectUri: redirectUri, navigateToLoginRequestUrl: false },
      cache: { cacheLocation: BrowserCacheLocation.SessionStorage, storeAuthStateInCookie: false },
      // Never log tokens or personal data.
      system: { allowRedirectInIframe: true, loggerOptions: { piiLoggingEnabled: false, logLevel: LogLevel.Warning, loggerCallback: () => {} } },
    });
    client.addEventCallback(event => {
      if (event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS || event.eventType === EventType.LOGIN_SUCCESS) {
        const account = (event.payload as AuthenticationResult | null)?.account;
        if (account) void this.checkpoint(account).catch(() => {});
      }
    });
    await client.initialize();
    this.client = client;
    return client;
  }
  private async checkpoint(account: AccountInfo): Promise<void> {
    const snapshot = captureSession(this.clientId(), account);
    if (snapshot) await window.emailAgentHost.microsoftSession('set', snapshot);
  }

  /** Microsoft's page runs in a browser window opened by the extension; MSAL only prepares and reads the URLs. */
  private async flow(request: Record<string, unknown>, login: boolean, interactive = true): Promise<AuthenticationResult> {
    if (this.flowPending) throw new Error('Ya hay una autorización de Microsoft en curso. Completa o cierra esa ventana antes de volver a intentarlo.');
    this.flowPending = true;
    try {
      const client = await this.pca();
      let authorizationUrl = '';
      const redirect = window.emailAgentHost.microsoftRedirect();
      const redirectRequest = { ...request, scopes: request.scopes as string[], redirectUri: redirect, responseMode: 'fragment' as never, onRedirectNavigate: (url: string) => { authorizationUrl = url; return false; } };
      await client.handleRedirectPromise();
      if (login) await client.loginRedirect(redirectRequest); else await client.acquireTokenRedirect(redirectRequest);
      if (!authorizationUrl) throw new Error('Microsoft no preparó la autorización.');
      let response: string | undefined;
      try { response = await window.emailAgentHost.microsoftFlow(authorizationUrl, interactive); }
      catch (error) {
        const state = new URL(authorizationUrl).searchParams.get('state') || '';
        try { await client.handleRedirectPromise('#error=access_denied&error_description=Cancelled&state=' + encodeURIComponent(state)); } catch { /* the request is discarded either way */ }
        throw error;
      }
      if (!response || !response.startsWith(redirect + '#')) throw new Error('La autorización se canceló o no devolvió una respuesta válida.');
      const result = await client.handleRedirectPromise(new URL(response).hash);
      if (!result?.account) throw new Error('Microsoft no devolvió una cuenta autorizada.');
      const expected = window.emailAgentHost.pageAccount?.email;
      if (expected && result.account.username.toLowerCase() !== expected.toLowerCase()) {
        await client.clearCache({ account: result.account });
        throw new Error('La cuenta autorizada no coincide con la página de Outlook.');
      }
      client.setActiveAccount(result.account);
      await window.emailAgentHost.microsoftRemember(result.account.username);
      await this.checkpoint(result.account).catch(() => {});
      return result;
    } finally { this.flowPending = false; }
  }

  isConnected(): boolean { return !!this.account; }
  getSessionKey(): string { return this.account ? 'outlook:' + this.account.homeAccountId : 'outlook:simulated'; }
  accountEmail(): string { return this.account?.username || ''; }

  async restoreSession(): Promise<void> {
    if (!this.clientId()) return;
    try {
      let remembered: string | null = null;
      try {
        const snapshot = await window.emailAgentHost.microsoftSession('get');
        if (snapshot) { hydrateSession(this.clientId(), snapshot); remembered = snapshot.email; }
      } catch { /* no saved session */ }
      const client = await this.pca();
      const page = window.emailAgentHost.pageAccount;
      const accounts = client.getAllAccounts();
      const expected = page?.email || remembered;
      let account: AccountInfo | null | undefined = expected
        ? accounts.find(value => value.username.toLowerCase() === expected.toLowerCase())
        : !page ? (client.getActiveAccount() || (accounts.length === 1 ? accounts[0] : undefined)) : undefined;
      if (expected && !(await window.emailAgentHost.microsoftAutoAllowed(expected))) account = undefined;
      else if (!account && expected) {
        try { account = (await this.flow({ scopes: READ_SCOPES, loginHint: expected, prompt: 'none' }, true, false)).account; } catch { /* the person connects by hand */ }
      }
      if (account) { client.setActiveAccount(account); this.account = account; }
    } catch { this.account = null; }
  }

  async connect(): Promise<void> {
    await window.emailAgentHost.ready;
    if (!this.clientId()) { await window.emailAgentHost.openOptions(); throw new Error('Falta configurar Microsoft en las opciones de la extensión.'); }
    try {
      const result = await this.flow({ scopes: READ_SCOPES, prompt: 'select_account', loginHint: window.emailAgentHost.pageAccount?.email }, true);
      this.account = result.account; this.folderIds = null;
    } catch (error) {
      const value = error as { errorCode?: string; errorMessage?: string; message?: string };
      throw new Error(value?.errorCode === 'user_cancelled'
        ? 'Microsoft no terminó la autorización. Si la ventana mostró redirect_uri, registra la dirección de Ajustes como SPA en Microsoft Entra.'
        : describeMicrosoftError(value));
    }
  }

  async disconnect(): Promise<void> {
    const account = this.account;
    this.account = null; this.folderIds = null;
    if (!account) return;
    await window.emailAgentHost.microsoftRemember(account.username, true).catch(() => {});
    await window.emailAgentHost.microsoftSession('clear', undefined, account.username).catch(() => {});
    await (await this.pca()).clearCache({ account }).catch(() => {});
  }

  storageAccessToken(): Promise<string> { return this.token('read'); }

  /** Writes ask Microsoft for the extra permission the first time, from the approval the person just gave. */
  private async token(mode: Mode, interactive = true): Promise<string> {
    const account = this.account;
    if (!account) throw new Error('Conecta tu cuenta de Outlook.');
    await window.emailAgentHost.validatePageAccount(account.username);
    const scopes = mode === 'send' ? SEND_SCOPES : mode === 'write' ? WRITE_SCOPES : READ_SCOPES;
    const client = await this.pca();
    let result: AuthenticationResult;
    try { result = await client.acquireTokenSilent({ scopes, account }); }
    catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) throw error;
      if (!interactive) throw new Error('Microsoft requiere autorización.');
      try { result = await this.flow({ scopes, account, loginHint: account.username }, false); }
      catch (flowError) { throw new Error(describeMicrosoftError(flowError as { message?: string })); }
    }
    if (result.account?.homeAccountId !== account.homeAccountId || this.account?.homeAccountId !== account.homeAccountId) throw new Error('La cuenta cambió durante la operación.');
    return result.accessToken;
  }

  private async graph<T>(method: string, path: string, body?: unknown, mode: Mode = 'read', interactive = true): Promise<T> {
    const url = path.startsWith('https://') ? path : GRAPH + path;
    if (!url.startsWith(GRAPH + '/')) throw new Error('Dirección Graph inválida.');
    const session = this.getSessionKey();
    const send = async (token: string) => fetch(url, {
      method, headers: { Authorization: 'Bearer ' + token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const token = await this.token(mode, interactive);
    await graphSlots.acquire();
    let response: Response;
    try {
      response = await send(token);
      // Only reads are retried. A write is never repeated automatically.
      if (response.status === 401 && method === 'GET') response = await send(await this.token(mode, interactive));
      // Graph says how long to wait when it throttles; reads wait that long (up to 10 s) and try again, twice at most.
      for (let attempt = 1; attempt <= 2 && method === 'GET' && [429, 503, 504].includes(response.status); attempt++) {
        const seconds = Number(response.headers.get('Retry-After'));
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Number.isFinite(seconds) && seconds > 0 ? seconds : attempt * 2) * 1000));
        response = await send(token);
      }
    } finally {
      graphSlots.release();
    }
    if (session !== this.getSessionKey()) throw new Error('La sesión cambió durante la operación.');
    if (response.status === 429) throw new Error(OUTLOOK_LIMIT_MESSAGE);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(data.error?.message || `Outlook respondió con el error ${response.status}.`);
    }
    return (response.status === 202 || response.status === 204 ? undefined : await response.json()) as T;
  }

  /** Ids of the well-known folders, so messages found by a search can be placed in Entrada, Enviados or Papelera. */
  private async knownFolders(): Promise<Record<string, string>> {
    const key = this.getSessionKey();
    if (this.folderIds?.key === key) return this.folderIds.ids;
    const ids: Record<string, string> = {};
    let throttled = false;
    // One at a time: Graph allows only a few simultaneous requests per mailbox.
    for (const [name, wellKnown] of Object.entries(FOLDERS)) {
      try { ids[name] = (await this.graph<{ id: string }>('GET', `/me/mailFolders/${wellKnown}?$select=id`)).id; }
      catch (error) { if ((error as Error).message === OUTLOOK_LIMIT_MESSAGE) throttled = true; /* otherwise the folder does not exist */ }
    }
    // A throttled lookup is asked again next time instead of being remembered incomplete.
    if (!throttled) this.folderIds = { key, ids };
    return ids;
  }

  async fetchEmails(query: string = 'in:inbox', maxResults: number = 10): Promise<Email[]> {
    if (!this.account) throw new Error('No hay una sesión activa de Outlook. Conecta tu cuenta.');
    const found: { folder: string | null; flagged: boolean } = { folder: null, flagged: false };
    const rest = query.replace(/\bin:(\w+)/g, (_, name: string) => { found.folder = name; return ''; }).replace(/\bis:starred\b/g, () => { found.flagged = true; return ''; }).trim();
    const { folder, flagged } = found;
    const wellKnown = folder ? FOLDERS[folder] : undefined;
    const params = new URLSearchParams({ $top: String(Math.min(Math.max(maxResults, 1), MAX_LOADED)), $select: SELECT });
    const search = toKql(rest);
    if (search) params.set('$search', `"${search}"`);
    else if (flagged) params.set('$filter', "flag/flagStatus eq 'flagged'");
    else params.set('$orderby', 'receivedDateTime desc');
    const base = wellKnown ? `/me/mailFolders/${wellKnown}/messages` : '/me/messages';
    const ids = await this.knownFolders();
    const data = await this.graph<{ value?: GraphMessage[] }>('GET', `${base}?${params.toString().replace(/\+/g, '%20')}`);
    let messages = data.value || [];
    // Like Gmail, a search across all mail leaves out trash and spam.
    if (!wellKnown) messages = messages.filter(m => m.parentFolderId !== ids.trash && m.parentFolderId !== ids.spam);
    if (flagged && search) messages = messages.filter(m => m.flag?.flagStatus === 'flagged');
    return messages.map(m => this.toEmail(m, ids, wellKnown ? folder : null)).sort((a, b) => b.timestamp - a.timestamp);
  }

  private toEmail(m: GraphMessage, ids: Record<string, string>, folder: string | null): Email {
    const html = m.body?.contentType === 'html' ? m.body.content : '';
    const plain = m.body?.contentType === 'text' ? m.body.content : '';
    const body = plain || (html ? inspectHtml(html).text : '') || m.bodyPreview || '';
    const sender = m.from?.emailAddress.address || '';
    const senderName = m.from?.emailAddress.name || sender;
    const categories = m.categories || [];
    const place = folder || Object.entries(ids).find(([, id]) => id === m.parentFolderId)?.[0] || '';
    const insights = analyzeMail({ subject: m.subject || '', sender, senderName, text: plain || m.bodyPreview || '', html: html || undefined,
      labels: categories, hasAttachments: m.hasAttachments, replyTo: m.replyTo?.[0]?.emailAddress.address, partial: !m.body?.content });
    const flaggedMessage = m.flag?.flagStatus === 'flagged';
    // Gmail-style system labels, so the shared agent can tell sent, unread and starred mail apart.
    const system = [place === 'sent' ? 'SENT' : place === 'inbox' ? 'INBOX' : place === 'trash' ? 'TRASH' : '', m.isRead ? '' : 'UNREAD', flaggedMessage ? 'STARRED' : ''].filter(Boolean);
    return {
      id: m.id, sender, senderName,
      recipient: (m.toRecipients || []).map(r => r.emailAddress.address).filter(Boolean).join(', ') || 'me',
      subject: m.subject || '(Sin asunto)', snippet: m.bodyPreview || '', body, bodyHtml: html || undefined,
      date: new Date(m.receivedDateTime).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.parse(m.receivedDateTime) || Date.now(),
      read: !!m.isRead,
      category: (CATEGORIES.find(c => categories.includes(c)) || 'Sin clasificar'),
      insights,
      priority: m.importance === 'high' || insights.categories.includes('Importante') ? 'urgent' : 'normal',
      labels: [...system, ...categories],
      starred: flaggedMessage,
      manualCategories: categories.filter(name => (MANUAL_CATEGORIES as readonly string[]).includes(name)),
      trashed: place === 'trash',
      hasAttachments: !!m.hasAttachments,
    };
  }

  private async move(ids: string[], destinationId: string, failure: string): Promise<void> {
    const session = this.getSessionKey();
    for (const id of ids) {
      if (session !== this.getSessionKey()) throw new Error('La sesión cambió. Se detuvo el resto de la operación.');
      try { await this.graph('POST', `/me/messages/${encodeURIComponent(id)}/move`, { destinationId }, 'write'); }
      catch (error) { throw new Error(`${failure} ${(error as Error).message}`.trim()); }
    }
  }
  trashEmails(ids: string[]): Promise<void> { return this.move(ids, 'deleteditems', 'Outlook no confirmó el movimiento a Elementos eliminados. Revisa el buzón antes de crear otra propuesta.'); }
  untrashEmails(ids: string[]): Promise<void> { return this.move(ids, 'inbox', 'Outlook no confirmó la recuperación. Revisa Elementos eliminados antes de volver a intentarlo.'); }

  /** Categories are read right before the change, so other categories are never overwritten with an old copy. */
  private async updateCategories(ids: string[], change: (current: string[]) => string[]): Promise<void> {
    for (const id of ids) {
      const path = `/me/messages/${encodeURIComponent(id)}`;
      const current = await this.graph<{ categories?: string[] }>('GET', path + '?$select=id,categories');
      await this.graph('PATCH', path, { categories: change(current.categories || []) }, 'write');
    }
  }
  labelEmails(ids: string[], labelName: string): Promise<void> { return this.updateCategories(ids, list => [...new Set([...list, labelName])]); }
  removeLabel(ids: string[], labelName: string): Promise<void> { return this.updateCategories(ids, list => list.filter(name => name.toLowerCase() !== labelName.toLowerCase())); }

  /** Listed only when a message with attachments is opened; contents are not included. */
  async listAttachments(email: Email): Promise<MailAttachment[]> {
    if (!email.hasAttachments) return [];
    const data = await this.graph<{ value?: { id: string; name?: string; contentType?: string; size?: number; '@odata.type'?: string }[] }>('GET', `/me/messages/${encodeURIComponent(email.id)}/attachments?$select=id,name,contentType,size`);
    return (data.value || []).map(item => ({ id: item.id, name: item.name || 'adjunto', type: item.contentType || 'application/octet-stream', size: item.size || 0,
      unsupported: item['@odata.type'] !== undefined && item['@odata.type'] !== '#microsoft.graph.fileAttachment' }));
  }

  async downloadAttachment(email: Email, attachment: MailAttachment): Promise<Blob> {
    if (attachment.unsupported) throw new Error('Este adjunto es un elemento de Outlook (por ejemplo, un correo o un evento) y no se puede descargar como archivo.');
    const data = await this.graph<{ contentBytes?: string }>('GET', `/me/messages/${encodeURIComponent(email.id)}/attachments/${encodeURIComponent(attachment.id)}`);
    if (!data.contentBytes) throw new Error('Outlook no entregó el contenido del adjunto.');
    return base64ToBlob(data.contentBytes, attachment.type);
  }

  /** Opening a message never opens a Microsoft window: without write permission it simply stays unread. */
  async markAsRead(id: string): Promise<void> {
    if (!this.account) return;
    try { await this.graph('PATCH', `/me/messages/${encodeURIComponent(id)}`, { isRead: true }, 'write', false); }
    catch (error) { if ((error as Error).message !== 'Microsoft requiere autorización.') throw error; }
  }

  async sendEmail(recipient: string, subject: string, body: string, attachments: MailFile[] = []): Promise<void> {
    if (!this.account) throw new Error('Sesión no autorizada');
    const addresses = recipient.split(/[;,]/).map(value => value.trim()).filter(Boolean);
    if (!addresses.length || addresses.some(a => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(a)) || /[\r\n]/.test(subject)) throw new Error('Revisa el destinatario y el asunto.');
    if (attachments.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error(`Los adjuntos superan el límite de ${MAX_ATTACHMENT_LABEL} por mensaje.`);
    const message = {
      subject: subject || '(Sin asunto)', body: { contentType: 'Text', content: cleanMessageBody(body) },
      toRecipients: addresses.map(address => ({ emailAddress: { address } })),
      attachments: attachments.map(file => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: file.name, contentType: file.type || 'application/octet-stream', contentBytes: file.data })),
    };
    await this.graph('POST', '/me/sendMail', { message, saveToSentItems: true }, 'send');
  }
}

export const outlookProvider = new OutlookProvider();
