import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Header } from './components/Header';
import { WorkspaceStorage,boundedChat,isStorageProblem } from '@shared/storage/workspace-storage';
import type { StoredDraft } from '@shared/storage/workspace-storage';
import type { Message as ChatViewMessage } from './components/AgentChat';
import { AgentChat, type ExternalPrompt } from './components/AgentChat';
import { PendingActionsList } from './components/PendingActionsList';
import { EmailInbox, type MailFolder } from './components/EmailInbox';
import { ComposeModal, type ComposeValue } from './components/ComposeModal';
import { AuditLogView } from './components/AuditLogView';
import { GmailAuthModal } from './components/GmailAuthModal';
import { emailProvider } from './services/mockEmailProvider';
import { mailProvider } from './services/mailProvider';
import { MAIL, ACCOUNT, STORAGE_PROVIDER, LOAD_STEP, MAX_LOADED, savedMailCount, saveMailCount } from './services/platform';
import { agentEngine } from './services/agentEngine';
import { parseStamp, requestedWhen } from './services/dates';
import { loadProviderChoice } from './services/llmClient';
import { draftBodyFromHtml, draftHtml, draftText } from './services/richText';
import { loadSignature, withSignature } from './services/signature';
import { askConfirm, ConfirmHost, notify } from './components/ConfirmDialog';
import { fromStoredProposals, toStoredProposals } from './services/proposalStore';
import { guardrails } from './services/guardrails';
import type { Email, PendingAction, AuditLog, AgentStep, MailFile, MailAttachment } from './types/email';
import { MANUAL_BODY_PLACEHOLDER } from './services/mailIntent';
import { Mail, ShieldAlert, History, AlertTriangle, Bot, Settings, LayoutDashboard, Clock } from 'lucide-react';
import { analyzeMail, addFinding } from '@shared/mail/mail-insights';
import type { AttachmentFinding } from '@shared/mail/attachment-scan';
import { senderAuthentication } from '@shared/mail/sender-intel';
import { observeSenders, applySenderContext, needsSentScan, markSentScan } from './services/senderHistory';
import { applyLearnedCategories, learnCategory } from './services/categoryMemory';
import { learnContacts, recordSent, sentScanSize, markSentScanned, contactsAtDomain } from './services/contacts';
import '@shared/styles/mail-insights.css';
import '@shared/styles/nexo-ui.css';
import './gmail-reader.css';
import { WorkspacePages } from './components/WorkspacePages';
import { PrivacyConsent, recordConsent } from './components/PrivacyConsent';

/** Adds what the attachments really contain (checked when the message is opened) to each message's analysis. */
function withAttachmentFindings(list:Email[],found:Record<string,AttachmentFinding[]>):Email[]{
  return list.map(email=>{
    const findings=found[email.id];
    if(!findings?.length || !email.insights)return email;
    return {...email,insights:findings.reduce((insights,finding)=>addFinding(insights,finding.reason,finding.weight),email.insights)};
  });
}

/** Adds what NexoMail knows from this account's own history (look-alike domains, new senders, hijacked threads). */
/** «Pedida hoy a las 23:40.» for the history: when the proposal was asked for, apart from when it was decided. */
const requestedNote=(action:PendingAction)=>{const when=requestedWhen(action.createdAt);return when?` Pedida ${when}.`:'';};

function withSenderContext(list:Email[]):Email[]{
  const session=mailProvider.getSessionKey();
  observeSenders(session,list);
  learnContacts(session,list,mailProvider.accountEmail());
  return applyLearnedCategories(session,applySenderContext(session,list),mailProvider.accountEmail());
}

export function App() {
  const database=useRef<WorkspaceStorage|null>(null);
  const [storageStatus,setStorageStatus]=useState('PostgreSQL · Conecta tu cuenta para recuperar los datos');
  const [storageReady,setStorageReady]=useState(false);
  const [storageLoading,setStorageLoading]=useState(false);
  /** Saving proposals starts only after the saved ones were read, so an empty list never overwrites them. */
  const [proposalsReady,setProposalsReady]=useState(false);
  const [restoredChat,setRestoredChat]=useState<ChatViewMessage[]|null>(null);
  const [savedDrafts,setSavedDrafts]=useState<StoredDraft[]>([]);
  const [autoGrouping,setAutoGrouping]=useState(true);
  const executingActions=useRef(new Set<string>());
  const attemptedActions=useRef(new Set<string>());
  const [rawEmails, setEmails] = useState<Email[]>([]);
  const refreshBusy=useRef(false);
  /** Pending background read of the sent folder (contacts), so refreshes never start two. */
  const sentScanTimer=useRef(0);
  const [lastSync,setLastSync]=useState<Date|null>(null);
  /** Bumped when the sent folder teaches NexoMail new contacts, so the analysis is redone. */
  const [historyVersion,setHistoryVersion]=useState(0);
  /** What the content check of each message's attachments found (phase 3), by message id. */
  const [attachmentFindings,setAttachmentFindings]=useState<Record<string,AttachmentFinding[]>>({});
  const onAttachmentFindings=useCallback((email:Email,findings:AttachmentFinding[])=>setAttachmentFindings(prev=>JSON.stringify(prev[email.id])===JSON.stringify(findings)?prev:{...prev,[email.id]:findings}),[]);
  const emails=useMemo(()=>withAttachmentFindings(withSenderContext(rawEmails.map(email=>({...email,insights:email.insights || analyzeMail({subject:email.subject,sender:email.sender,senderName:email.senderName,text:email.body,html:email.bodyHtml,
    auth:email.authHeaders?senderAuthentication(email.authHeaders,email.sender):undefined,labels:[...email.labels,email.category]})}))),attachmentFindings),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rawEmails,historyVersion,attachmentFindings]);
  const securityAlerts=emails.filter(email=>email.insights?.level!=='none');
  /** Strong signs of fraud, apart from details worth a look: one red count for everything made people distrust real mail. */
  const dangerousMail=securityAlerts.filter(email=>email.insights?.level==='high');
  const reviewMail=securityAlerts.filter(email=>email.insights?.level==='review');
  const [isGmailConnected, setIsGmailConnected] = useState<boolean>(mailProvider.isConnected());
  const [gmailError, setGmailError] = useState<string | null>(null);
  /** A passing notice (the provider asked to wait), shown without the re-authorize button. */
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const authorizationPending=useRef(false);
  const [isAuthorizing,setIsAuthorizing]=useState(false);
  const [consentOpen,setConsentOpen]=useState(false);
  /** Every connection goes through the privacy notice first, including after a disconnection. */
  const consentClientId=useRef<string|undefined>(undefined);
  async function authorizeGmail(clientId?:string){
    if(authorizationPending.current)return;
    consentClientId.current=clientId;
    setConsentOpen(true);
  }
  async function startGmailAuthorization(){
    if(authorizationPending.current)return;
    authorizationPending.current=true;setIsAuthorizing(true);setGmailError(null);
    try{
      await mailProvider.connect(consentClientId.current);
      // Recorded only once the account is really connected, with the account it applies to.
      recordConsent(MAIL,mailProvider.accountEmail());
      setIsAuthModalOpen(false);setPendingActions([]);agentEngine.clearHistory();
      await refreshEmails();
    }catch(error){setGmailError(error instanceof Error?error.message:`${ACCOUNT} no completó la autorización.`);}
    finally{authorizationPending.current=false;setIsAuthorizing(false);}
  }
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([
    {
      id: 'aud_init',
      timestamp: new Date().toISOString(),
      actionType: 'LIST_EMAILS',
      prompt: 'Inicialización de la sesión',
      executionStatus: 'AUTO_EXECUTED',
      details: 'Interfaz iniciada. Las acciones sensibles requieren aprobación humana.'
    }
  ]);
  const [strictMode, setStrictMode] = useState<boolean>(true);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'inbox' | 'pending' | 'audit' | 'summary' | 'settings'>('inbox');
  const [selectedCategory, setSelectedCategory] = useState<string>('Todos');
  const [mailFolder, setMailFolder] = useState<MailFolder>('inbox');
  const [folderEmails, setFolderEmails] = useState<Email[] | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  /** Messages to load: the chosen amount, plus whatever "Cargar más" added for the open folder. */
  const [mailCount, setMailCount] = useState(savedMailCount);
  const [loadLimit, setLoadLimit] = useState(savedMailCount);
  const loadLimitRef = useRef(loadLimit);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [compose, setCompose] = useState<ComposeValue | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<ExternalPrompt | null>(null);
  const addAudit = (actionType: AuditLog['actionType'], prompt: string, executionStatus: AuditLog['executionStatus'], details: string) =>
    setAuditLogs(prev => [{ id: crypto.randomUUID(), timestamp: new Date().toISOString(), actionType, prompt, executionStatus, details }, ...prev]);

  const FOLDER_QUERIES: Record<Exclude<MailFolder, 'inbox' | 'drafts'>, string> = { sent: 'in:sent', starred: 'is:starred', all: '', spam: 'in:spam', trash: 'in:trash' };
  /** Folders other than Entrada are loaded on demand, only when the person opens them. */
  const loadFolder = async (folder: MailFolder) => {
    if (folder === 'inbox' || folder === 'drafts') return;
    setFolderLoading(true);
    try {
      if (mailProvider.isConnected()) setFolderEmails(await mailProvider.fetchEmails(FOLDER_QUERIES[folder], loadLimitRef.current));
      else {
        const all = emailProvider.getEmails();
        setFolderEmails(folder === 'trash' ? emailProvider.getTrashedEmails() : folder === 'spam' ? all.filter(e => e.labels.some(label => label.toLowerCase() === 'spam')) : folder === 'sent' ? all.filter(e => e.labels.includes('Enviado')) : folder === 'starred' ? all.filter(e => e.starred) : all);
      }
    } catch (error) {
      setFolderEmails([]);
      void notify(error instanceof Error ? error.message : 'No se pudo abrir la carpeta.');
    } finally {
      setFolderLoading(false);
    }
  };
  const setLimit = (value: number) => { loadLimitRef.current = value; setLoadLimit(value); agentEngine.setInboxScope(value); };
  const selectFolder = (folder: MailFolder) => { setLimit(mailCount); setMailFolder(folder); setFolderEmails(null); setSelectedCategory('Todos'); void loadFolder(folder); };
  const loadMore = async () => {
    setLimit(Math.min(MAX_LOADED, loadLimitRef.current + LOAD_STEP));
    setLoadingMore(true);
    try { if (mailFolder === 'inbox') await refreshEmails(); else await loadFolder(mailFolder); } finally { setLoadingMore(false); }
  };
  const changeMailCount = (value: number) => { saveMailCount(value); setMailCount(value); setLimit(value); if (mailFolder === 'inbox') void refreshEmails(); else void loadFolder(mailFolder); };
  /** A mail linked from a chat answer: open it in Correo (expanding the floating panel first). */
  const [openRequest, setOpenRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [mailFocus, setMailFocus] = useState<{ id: string; nonce: number } | null>(null);
  const syncMail = async () => { setSyncing(true); try { if (mailFolder === 'inbox') await refreshEmails(); else await loadFolder(mailFolder); } finally { setSyncing(false); } };

  /** Writing by hand follows the same path as the agent: a proposal that waits in Acciones. */
  const submitCompose = (value: ComposeValue) => {
    const action = guardrails.createPendingAction('SEND_EMAIL', `Enviar correo a ${value.to}`, `Asunto: "${value.subject}"`,
      { recipient: value.to, cc: value.cc || undefined, bcc: value.bcc || undefined, subject: value.subject, body: value.body, bodyHtml: value.bodyHtml, attachments: value.files.length ? value.files : undefined, savedDraftId: value.draftId, replyToSender: value.replyToSender, isReal: mailProvider.isConnected(), sessionKey: mailProvider.getSessionKey() },
      'Lo redactaste tú. Revísalo y apruébalo para enviarlo.');
    action.isEditable = true;
    setPendingActions(prev => [action, ...prev]);
    setCompose(null);
    setActiveTab('pending'); setMobileView('workspace');
  };
  const saveComposeDraft = (value: ComposeValue) => {
    // Formatting is kept (behind a mark in the same text column); images and attachments are not stored in drafts.
    const rich = value.bodyHtml ? draftBodyFromHtml(value.bodyHtml) : null;
    const draft: StoredDraft = { id: value.draftId ?? crypto.randomUUID(), to: value.to.trim(), cc: (value.cc ?? '').trim(), bcc: (value.bcc ?? '').trim(), subject: value.subject, body: rich?.body ?? value.body, reply_to_id: null, attachments_omitted: value.files.length > 0 || !!rich?.droppedImages, created_at: new Date().toISOString() };
    setSavedDrafts(list => [draft, ...list.filter(d => d.id !== draft.id)].slice(0, 50));
    setCompose(null);
  };
  /**
   * «Verificar por otro canal»: the assistant writes to the real organization (a contact of yours there, or one you
   * give it), never to the suspicious address, asking whether the message is theirs. It stays in Acciones until approved.
   */
  /** The mail being verified: its proposal is fixed by code, whatever the assistant (or the local rules) answered. */
  const verifyGuard = useRef<{ email: Email; marker: string } | null>(null);
  const VERIFY_MARKER = 'correo de verificación para esa dirección oficial';
  /**
   * The destination of a verification is never left to the AI: it is the official address the person wrote,
   * never the sender being checked. If the assistant wrote no usable text, a short neutral one is used.
   */
  const enforceVerification = (prompt: string, actions: PendingAction[]): { actions: PendingAction[]; note: string } | null => {
    const guard = verifyGuard.current;
    if (!guard || !prompt.includes(guard.marker)) return null;
    verifyGuard.current = null;
    const avoid = guard.email.sender.toLowerCase();
    const official = (prompt.match(/[^\s<>()«»"',;:]+@[^\s<>()«»"',;:]+\.[a-z]{2,}/gi) ?? []).map(a => a.toLowerCase().replace(/\.$/, '')).find(a => a !== avoid);
    if (!official) return null;
    const subject = `Verificación: ¿nos enviaron este correo? «${guard.email.subject || '(sin asunto)'}»`;
    const template = `Hola:\n\nRecibí un correo que dice venir de ustedes y quiero confirmar si es auténtico antes de hacer nada.\n\n- Remitente: ${guard.email.sender}\n- Asunto: ${guard.email.subject || '(sin asunto)'}\n- Fecha: ${guard.email.date}\n\nNo he abierto sus enlaces ni adjuntos. ¿Pueden confirmarme si lo enviaron ustedes?\n\nGracias.`;
    const others = actions.filter(action => action.actionType !== 'SEND_EMAIL');
    let draft = actions.find(action => action.actionType === 'SEND_EMAIL');
    const usable = !!draft?.payload.body && !draft.payload.body.includes(MANUAL_BODY_PLACEHOLDER) && draft.payload.recipient?.toLowerCase() === official;
    if (!draft) draft = guardrails.createPendingAction('SEND_EMAIL', '', '', {}, 'Correo de verificación por otro canal. Revísalo y apruébalo para enviarlo.');
    draft.payload = { ...draft.payload, recipient: official, replyToSender: undefined, subject: usable ? draft.payload.subject || subject : subject, body: usable ? draft.payload.body : template, isReal: mailProvider.isConnected(), sessionKey: mailProvider.getSessionKey() };
    draft.title = `Enviar correo a ${official}`;
    draft.description = `Asunto: "${draft.payload.subject}"`;
    draft.isEditable = true;
    return { actions: [draft, ...others], note: `\n\nEl correo de verificación va a ${official}, la dirección que indicaste, nunca a ${guard.email.sender}. Revísalo en Acciones antes de aprobarlo.` };
  };
  const verifyByOtherChannel = (email: Email) => {
    const reasons = email.insights?.reasons.join(' ') ?? '';
    const real = reasons.match(/imita a [^(]*\(([^)\s]+)\)/)?.[1] ?? reasons.match(/se parece a ([a-z0-9.-]+\.[a-z]{2,})/i)?.[1] ?? reasons.match(/participaba ([a-z0-9.-]+\.[a-z]{2,})/i)?.[1];
    const contact = real ? contactsAtDomain(mailProvider.getSessionKey(), real)[0] : undefined;
    const about = `el correo «${email.subject || '(sin asunto)'}» que recibí de ${email.sender}${email.date ? ` (${email.date})` : ''}`;
    // Worded without negations or «sospechoso»: the quick local rules would read it as «do nothing» or as a question about risks.
    const rules = 'Resume en dos o tres frases qué pedía, omitiendo sus enlaces, archivos, números de cuenta y datos personales, y pide que me confirmen si es suyo. El único destinatario es la dirección oficial que te indico.';
    // Same editable panel as «Responder con IA»: the person writes or picks the official address before anything is drafted.
    const base = `Escribe a la organización real para verificar ${about}. Su dirección oficial es `;
    setAgentPrompt({ id: crypto.randomUUID(), text: contact ? base + contact.address : base, edit: {
      title: `Verificar por otro canal: «${email.subject || '(sin asunto)'}»`,
      hint: contact
        ? `Ya le escribiste a ${contact.address}, de ${real}. Puedes usarla o escribir otra que conozcas por su web oficial o una factura. No uses la del correo sospechoso.`
        : 'Completa el correo oficial de la organización (algo como contacto@empresa.com): búscalo en su web oficial, en «Contacto», o en una factura. No uses la del correo sospechoso.',
      base, options: real ? contactsAtDomain(mailProvider.getSessionKey(), real).map(c => ({ label: c.address, text: c.address })) : [],
      suffix: `Redacta con prepare_send_email un ${VERIFY_MARKER}. ${rules}`,
      requireAddress: { avoid: email.sender } } });
    verifyGuard.current = { email, marker: VERIFY_MARKER };
    setActiveTab('inbox'); setMobileView('chat');
  };
  /** «Responder con IA» opens the chat with an editable request and suggested answers; nothing is drafted until it is sent. */
  const replyWithAI = (email: Email) => {
    const base = `Responde al correo «${email.subject || '(sin asunto)'}» de ${email.sender} `;
    const options = [
      { label: 'Respuesta cordial', text: 'de forma cordial, respondiendo a lo que pide.' },
      { label: 'Aceptar', text: 'diciendo que acepto lo que propone.' },
      { label: 'Rechazar con amabilidad', text: 'rechazando con amabilidad lo que propone.' },
      { label: 'Pedir más información', text: 'pidiendo más información antes de decidir.' },
      { label: 'Agradecer', text: 'agradeciendo el mensaje.' },
      { label: 'Confirmar recepción', text: 'confirmando que lo recibí y que lo reviso pronto.' },
    ];
    setAgentPrompt({ id: crypto.randomUUID(), text: base + options[0].text, edit: { title: `Responder a ${email.senderName || email.sender}: «${email.subject || '(sin asunto)'}»`, hint: 'Escribe o elige qué quieres responder. La IA redactará el correo y lo dejará en Acciones para que lo revises.', base, options, suffix: `(Correo id=${email.id}. Prepara la respuesta con prepare_send_email para ${email.sender}.)` } });
    setMobileView('chat');
  };

  /** Restoring is reversible and asked for directly in the mail tab, so it runs without a separate approval. */
  /**
   * Applies a change to the messages on screen. Gmail or Outlook already confirmed it, so the whole
   * inbox is not downloaded again: that used to spend the account's per-minute quota.
   */
  const patchLocal = (ids: string[], change: (email: Email) => Email | null) => {
    const apply = (list: Email[]) => list.flatMap(email => ids.includes(email.id) ? (change(email) ?? []) : [email]);
    setEmails(prev => apply(prev));
    setFolderEmails(prev => prev ? apply(prev) : prev);
    agentEngine.invalidateInboxSnapshot();
  };
  /** Attachments come from the connected mailbox, or from the demo messages. */
  const listAttachments = useCallback((email: Email) => mailProvider.isConnected() ? mailProvider.listAttachments(email) : emailProvider.listAttachments(email), []);
  const downloadAttachment = useCallback((email: Email, attachment: MailAttachment) => mailProvider.isConnected() ? mailProvider.downloadAttachment(email, attachment) : emailProvider.downloadAttachment(email, attachment), []);
  const handleRestore = async (ids: string[]) => {
    try {
      if (mailProvider.isConnected()) await mailProvider.untrashEmails(ids);
      else emailProvider.restoreEmails(ids);
      addAudit('RESTORE_EMAIL', 'Recuperación manual desde la papelera', 'HUMAN_APPROVED', `${ids.length} correo(s) devuelto(s) a la bandeja de entrada.`);
    } catch (error) {
      addAudit('RESTORE_EMAIL', 'Recuperación manual desde la papelera', 'FAILED', error instanceof Error ? error.message : 'No se pudo recuperar.');
      void notify(error instanceof Error ? error.message : 'No se pudo recuperar el correo.');
    }
    // Leaves the trash at once; the inbox refresh downloads only the recovered messages.
    setFolderEmails(prev => prev ? prev.filter(email => !ids.includes(email.id)) : prev);
    await refreshEmails();
  };

  const handleMarkSpam = async (ids: string[]) => {
    try {
      if (mailProvider.isConnected()) await mailProvider.markSpamEmails(ids);
      else emailProvider.markSpam(ids);
      addAudit('LABEL_EMAIL', 'Reportado como spam', 'HUMAN_APPROVED', `${ids.length} correo(s) movido(s) a No deseado.`);
    } catch (error) {
      addAudit('LABEL_EMAIL', 'Reportado como spam', 'FAILED', error instanceof Error ? error.message : 'No se pudo mover.');
      void notify(error instanceof Error ? error.message : 'No se pudo mover el correo a No deseado.');
    }
    setFolderEmails(prev => prev ? prev.filter(email => !ids.includes(email.id)) : prev);
    await refreshEmails();
  };

  const handleNotSpam = async (ids: string[]) => {
    try {
      if (mailProvider.isConnected()) await mailProvider.notSpamEmails(ids);
      else emailProvider.notSpam(ids);
      addAudit('RESTORE_EMAIL', 'Marcado como «no es spam»', 'HUMAN_APPROVED', `${ids.length} correo(s) movido(s) de No deseado a la bandeja de entrada.`);
    } catch (error) {
      addAudit('RESTORE_EMAIL', 'Marcado como «no es spam»', 'FAILED', error instanceof Error ? error.message : 'No se pudo mover.');
      void notify(error instanceof Error ? error.message : 'No se pudo mover el correo.');
    }
    setFolderEmails(prev => prev ? prev.filter(email => !ids.includes(email.id)) : prev);
    await refreshEmails();
  };

  /** Manual categories are Gmail labels: replacing one removes the previous manual label first. */
  const handleSetCategory = async (email: Email, category: string | null) => {
    const previous = email.manualCategories ?? [];
    try {
      if (mailProvider.isConnected()) {
        for (const old of previous) if (old !== category) await mailProvider.removeLabel([email.id], old);
        if (category && !previous.includes(category)) await mailProvider.labelEmails([email.id], category);
      } else {
        for (const old of previous) if (old !== category) emailProvider.removeLabel([email.id], old);
        if (category) emailProvider.labelEmails([email.id], category);
      }
      // The next messages from this sender get the same category automatically.
      learnCategory(mailProvider.getSessionKey(), email, category);
      setHistoryVersion(version => version + 1);
      patchLocal([email.id], item => ({ ...item, manualCategories: category ? [category] : [], labels: [...item.labels.filter(label => !previous.includes(label)), ...(category ? [category] : [])] }));
      addAudit('LABEL_EMAIL', `Clasificación manual: ${email.subject}`, 'HUMAN_APPROVED', category ? `Etiqueta «${category}» aplicada en ${MAIL}.` : 'Clasificación manual retirada.');
    } catch (error) {
      addAudit('LABEL_EMAIL', `Clasificación manual: ${email.subject}`, 'FAILED', error instanceof Error ? error.message : 'No se pudo clasificar.');
      void notify(error instanceof Error ? error.message : 'No se pudo clasificar el correo.');
    }
  };

  // Theme Management (Dark / Light)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
    if (saved === 'dark' || saved === 'light') return saved;
    return 'light';
  });

  // Mobile View Switcher (< 1024px)
  const isFloating=new URLSearchParams(location.search).get('floating')==='1';
  const [isExpanded,setIsExpanded]=useState(!isFloating);
  const floatingBridge=new URLSearchParams(location.search).get('bridge');
  const [mobileView, setMobileView] = useState<'chat' | 'workspace'>(isFloating?'chat':'workspace');

  useEffect(()=>{
    if(!isFloating || !floatingBridge)return;
    const onMessage=(event:MessageEvent)=>{
      if(event.source!==window.parent || event.origin!==location.origin || event.data?.bridge!==floatingBridge)return;
      if(event.data.type==='EMAILAGENT_DISPLAY_MODE'){if(typeof event.data.expanded==='boolean')setIsExpanded(event.data.expanded);return;}
      if(event.data.type!=='EMAILAGENT_NAV')return;
      const section=event.data.section;
      if(section==='chat'){setMobileView('chat');}
      else if(section==='mail'){setActiveTab('inbox');setMobileView('workspace');}
      else if(section==='actions'){setActiveTab('pending');setMobileView('workspace');}
      else if(section==='history'){setActiveTab('audit');setMobileView('workspace');}
      else if(section==='settings'){setActiveTab('settings');setMobileView('workspace');}
    };
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape' && !document.querySelector('[role="dialog"],.modal-backdrop'))window.parent.postMessage({type:'EMAILAGENT_MINIMIZE',bridge:floatingBridge},location.origin);};
    window.addEventListener('message',onMessage);window.addEventListener('keydown',onKey);
    window.parent.postMessage({type:'EMAILAGENT_APP_READY',bridge:floatingBridge},location.origin);
    return()=>{window.removeEventListener('message',onMessage);window.removeEventListener('keydown',onKey);};
  },[isFloating,floatingBridge]);
  useEffect(()=>{if(isFloating && !isExpanded && mobileView==='workspace' && activeTab==='inbox')setMobileView('chat');},[isFloating,isExpanded,mobileView,activeTab]);
  useEffect(()=>{
    if(!openRequest || (isFloating && !isExpanded))return;
    setActiveTab('inbox');setMobileView('workspace');setMailFocus(openRequest);setOpenRequest(null);
  },[openRequest,isFloating,isExpanded]);
  function openMailFromChat(id:string){
    if(!emails.some(email=>email.id===id)){void notify('Ese correo ya no está entre los cargados: puede que lo hayas movido o que ya no esté entre los más recientes. Búscalo en la pestaña Correo.');return;}
    if(mailFolder!=='inbox')setMailFolder('inbox');
    setSelectedCategory('Todos');
    setOpenRequest({id,nonce:Date.now()});
    // The Correo tab only exists in full screen, so the floating panel is asked to expand.
    if(isFloating && !isExpanded && floatingBridge)window.parent.postMessage({type:'EMAILAGENT_EXPAND',bridge:floatingBridge},location.origin);
  }
  useEffect(()=>{if(isFloating && floatingBridge)window.parent.postMessage({type:'EMAILAGENT_VIEW',bridge:floatingBridge,section:isAuthModalOpen || (mobileView==='workspace' && activeTab==='settings')?'settings':mobileView==='chat'?'chat':activeTab==='pending'?'actions':activeTab==='audit'?'history':'mail'},location.origin);},[isFloating,floatingBridge,mobileView,activeTab,isAuthModalOpen]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if(isFloating && floatingBridge)window.parent.postMessage({type:'EMAILAGENT_THEME',theme,bridge:floatingBridge},location.origin);
  }, [theme]);

  const handleToggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  };

  const refreshEmails = async () => {
    if(refreshBusy.current)return;
    refreshBusy.current=true;
    try {
    setGmailError(null);
    if(window.emailAgentHost.pageAccount && !mailProvider.isConnected()){setEmails([]);setIsGmailConnected(false);setGmailError(window.emailAgentHost.pageAccount.email?'Conecta esta cuenta para autorizar NexoMail: '+window.emailAgentHost.pageAccount.email:'No se pudo identificar tu cuenta automáticamente. Abre el menú de tu cuenta del correo o pulsa Conectar cuenta.');return;}
    if (mailProvider.isConnected()) {
      try {
        const refreshKey=mailProvider.getSessionKey();
        const realEmails = await mailProvider.fetchEmails('in:inbox', loadLimitRef.current);
        if(refreshKey!==mailProvider.getSessionKey())return;
        setEmails(realEmails);setLastSync(new Date());setSyncNotice(null);agentEngine.setInboxSnapshot(withSenderContext(realEmails));
        // The sent folder tells NexoMail who your contacts are: the first time up to 200 messages back (so the AI
        // remembers addresses you wrote to long ago), then the newest ones once a day. Read-only, in the background,
        // and 20 s after connecting, so it never competes with loading the inbox or verifying the account.
        const scan=Math.max(sentScanSize(refreshKey),needsSentScan(refreshKey)?25:0);
        if(scan && !sentScanTimer.current)sentScanTimer.current=window.setTimeout(()=>{
          sentScanTimer.current=0;
          if(refreshKey!==mailProvider.getSessionKey())return;
          markSentScan(refreshKey);
          void mailProvider.fetchEmails('in:sent',scan).then(sent=>{if(refreshKey!==mailProvider.getSessionKey())return;observeSenders(refreshKey,sent);learnContacts(refreshKey,sent,mailProvider.accountEmail());markSentScanned(refreshKey);setHistoryVersion(v=>v+1);}).catch(()=>{});
        },20000);
        setIsGmailConnected(true);
        return;
      } catch (err: any) {
        console.error(`Error al cargar correos reales de ${MAIL}:`, err);
        setIsGmailConnected(true);
        // A per-minute limit is not an authorization problem: the mails on screen stay, nothing asks to re-authorize,
        // and the next automatic refresh (within a minute) tries again.
        if (/limitó temporalmente/.test(err?.message ?? '')) {
          setSyncNotice(`${MAIL} pidió esperar un momento antes de más consultas. Se muestran los correos de la última actualización; se reintentará solo en un minuto.`);
          return;
        }
        setGmailError(err.message || `Error de credenciales de ${ACCOUNT}`);
        setEmails([]);
        return;
      }
    }
    setEmails([...emailProvider.getEmails()]);
    setIsGmailConnected(false);
    } finally {refreshBusy.current=false;}
  };

  useEffect(() => {
    refreshEmails();
  }, []);

  // Every minute while visible, and right away when you come back to the tab after a while. Pending proposals do
  // not stop it (they keep their own copy of the mails they act on). It only waits while the agent is answering,
  // an approval is running or the account dialog is open. The latest values are read through a ref, so using the
  // chat does not restart the minute (before, chatting more than once a minute meant it never ran).
  const autoRefresh=useRef({busy:false,folder:mailFolder,last:0});
  autoRefresh.current.busy=isProcessing || isAuthModalOpen;
  autoRefresh.current.folder=mailFolder;
  useEffect(()=>{
    const tick=async(force=false)=>{
      const state=autoRefresh.current;
      if(document.visibilityState!=='visible' || !mailProvider.isConnected() || state.busy || executingActions.current.size)return;
      if(!force && Date.now()-state.last<55000)return;
      state.last=Date.now();
      await refreshEmails();
      // The folder on screen (Enviados, No deseado…) is refreshed too, not only Entrada.
      const folder=autoRefresh.current.folder;
      if(folder!=='inbox' && folder!=='drafts')await loadFolder(folder);
    };
    const timer=window.setInterval(()=>void tick(true),60000);
    // Every 10 s a tiny request asks the provider whether anything changed; the inbox is downloaded only then,
    // so new mail shows up in seconds without spending quota.
    let marker='',checking=false;
    const check=async()=>{
      const state=autoRefresh.current;
      if(checking || document.visibilityState!=='visible' || !mailProvider.isConnected() || state.busy || executingActions.current.size)return;
      checking=true;
      try{
        const session=mailProvider.getSessionKey();
        const next=await mailProvider.changeMarker();
        if(next && session===mailProvider.getSessionKey()){
          const changed=!!marker && next!==marker;
          marker=next;
          if(changed)await tick(true);
          else agentEngine.touchInboxSnapshot();
        }
      }catch{/* the minute timer stays as a fallback */}finally{checking=false;}
    };
    const quick=window.setInterval(()=>void check(),10000);
    // The mail page itself (Gmail's unread count in the tab title) tells the panel the moment something arrives.
    const fromPage=(event:MessageEvent)=>{if(event.source===window.parent && event.origin===location.origin && event.data?.type==='EMAILAGENT_MAIL_CHANGED' && (!floatingBridge || event.data.bridge===floatingBridge))void check();};
    window.addEventListener('message',fromPage);
    // Back to the tab or the window after more than ~half a minute: refresh now instead of waiting for the timer.
    const back=()=>{if(document.visibilityState==='visible' && Date.now()-autoRefresh.current.last>30000)void tick(true);};
    document.addEventListener('visibilitychange',back);
    window.addEventListener('focus',back);
    return()=>{window.clearInterval(timer);window.clearInterval(quick);window.removeEventListener('message',fromPage);document.removeEventListener('visibilitychange',back);window.removeEventListener('focus',back);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  useEffect(()=>{
    database.current?.close();database.current=null;setStorageReady(false);setProposalsReady(false);setStorageLoading(false);
    // Each account keeps the AI model chosen for it in this browser.
    loadProviderChoice(isGmailConnected?mailProvider.accountEmail():'');
    if(!isGmailConnected){setRestoredChat([]);setSavedDrafts([]);setAuditLogs([]);agentEngine.clearHistory();setStorageStatus('PostgreSQL · Conecta tu cuenta para recuperar los datos');return;}
    setStorageLoading(true);
    // The saved data belongs to an account, not to one Google/Microsoft session: a renewed session of the same
    // account (another tab, a new authorization) keeps saving. Before, it stopped with «La cuenta cambió».
    const owner=mailProvider.accountEmail().toLowerCase();
    const sameAccount=()=>mailProvider.isConnected() && !!owner && mailProvider.accountEmail().toLowerCase()===owner;
    const store=new WorkspaceStorage(STORAGE_PROVIDER,window.emailAgentHost.config,async()=>{
      if(!sameAccount())throw new Error('La cuenta cambió.');
      const token=await mailProvider.storageAccessToken();
      if(!sameAccount())throw new Error('La cuenta cambió.');
      return token;
    },setStorageStatus);
    database.current=store;
    let active=true;
    void store.load().then(data=>{
      if(!active || !sameAccount())return;
      setRestoredChat(data.sections.chat.data.map(message=>({id:message.id,sender:message.role==='user'?'user':'agent',text:message.content,created_at:message.created_at,timestamp:new Date(message.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})));
      agentEngine.restoreTextHistory(data.sections.chat.data);
      setSavedDrafts(data.sections.drafts.data);
      setAuditLogs(data.audit.map(event=>({id:event.id,timestamp:event.occurred_at,actionType:event.action_type as AuditLog['actionType'],prompt:event.description,executionStatus:event.status as AuditLog['executionStatus'],details:event.details})));
      const prefs=data.sections.preferences.data;
      if(prefs){setTheme(prefs.theme);setStrictMode(prefs.strict_mode);guardrails.setStrictMode(prefs.strict_mode);setAutoGrouping(prefs.auto_grouping);}
      setStorageReady(true);
      void store.loadProposals().then(list=>{
        if(!active || !sameAccount())return;
        const restored=fromStoredProposals(list,mailProvider.getSessionKey(),mailProvider.isConnected());
        if(restored.length)setPendingActions(prev=>[...prev,...restored.filter(item=>!prev.some(existing=>existing.id===item.id))]);
        setProposalsReady(true);
      }).catch(()=>{});
    }).catch(()=>{}).finally(()=>{if(active)setStorageLoading(false);});
    return()=>{active=false;store.close();};
  },[isGmailConnected]);
  useEffect(()=>{
    const onUnload=()=>{database.current?.flush();};
    window.addEventListener('beforeunload',onUnload);
    window.addEventListener('pagehide',onUnload);
    return()=>{window.removeEventListener('beforeunload',onUnload);window.removeEventListener('pagehide',onUnload);};
  },[]);
  useEffect(()=>{if(storageReady && proposalsReady)database.current?.saveProposals(toStoredProposals(pendingActions));},[pendingActions,storageReady,proposalsReady]);
  useEffect(()=>{if(storageReady)database.current?.schedule('drafts',savedDrafts);},[savedDrafts,storageReady]);
  useEffect(()=>{if(storageReady)database.current?.schedule('preferences',{theme,strict_mode:strictMode,llm_enabled:true,auto_grouping:autoGrouping});},[theme,strictMode,autoGrouping,storageReady]);
  useEffect(()=>{if(storageReady)database.current?.appendAudit(auditLogs.map(event=>({id:event.id,action_type:event.actionType,status:event.executionStatus,description:event.prompt,details:event.details,occurred_at:parseStamp(event.timestamp)?.toISOString() ?? new Date().toISOString()})));},[auditLogs,storageReady]);
  const saveChat=(messages:ChatViewMessage[])=>{
    if(storageReady)database.current?.schedule('chat',boundedChat(messages.filter(message=>!message.id.startsWith('m-') && message.id!=='m-1').map(message=>({id:message.id,role:message.sender==='user'?'user':'assistant',content:message.text,created_at:message.created_at || new Date().toISOString()}))),true);
  };

  const eraseStoredData=async()=>{
    if(!database.current?.ready || !(await askConfirm({title:'¿Vaciar los datos guardados?',message:'Se borrarán el chat, los borradores, las preferencias y la auditoría de esta cuenta en PostgreSQL. No se borrarán correos del buzón.',confirmLabel:'Vaciar',danger:true})))return;
    try{await database.current.erase();location.reload();}catch(error){setStorageStatus((error as Error).message);}
  };

  const handleToggleStrictMode = () => {
    const next = !strictMode;
    setStrictMode(next);
    guardrails.setStrictMode(next);
  };

  const handleSendPrompt = async (prompt: string, files: MailFile[] = []): Promise<{ answer: string; steps: AgentStep[]; attachmentsUsed?: boolean }> => {
    if(window.emailAgentHost.pageAccount && !mailProvider.isConnected())return {answer:'Conecta la cuenta de esta página en Ajustes antes de consultar o preparar acciones sobre sus correos.',steps:[]};
    setIsProcessing(true);
    try {
      const sessionKey=mailProvider.getSessionKey();
      const res = await agentEngine.processPrompt(prompt, files.map(file=>file.name));
      if(sessionKey!==mailProvider.getSessionKey())throw new Error('La sesión cambió durante la consulta. Vuelve a intentarlo.');
      const verified = enforceVerification(prompt, res.pendingActions);
      if (verified) { res.pendingActions = verified.actions; res.finalAnswer = res.pendingActions.length && /no se podrá aprobar|Escribe el mensaje/i.test(res.finalAnswer) ? 'Preparé el correo de verificación.' + verified.note : res.finalAnswer + verified.note; }
      // Files go with the message the agent prepared; nothing is sent until it is approved.
      const draft=files.length?res.pendingActions.find(action=>action.actionType==='SEND_EMAIL'):undefined;
      if(draft){draft.payload.attachments=files;res.finalAnswer+=`\n\nAdjunté ${files.length===1?'1 archivo':files.length+' archivos'} al correo propuesto.`;}
      else if(files.length)res.finalAnswer+='\n\nNo adjunté los archivos porque no se preparó ningún correo. Siguen listos: pide redactar un correo con su destinatario.';
      
      if(storageReady){
        const drafts:StoredDraft[]=res.pendingActions.filter(action=>action.actionType==='SEND_EMAIL').map(action=>({id:action.id,to:action.payload.recipient || '',cc:'',bcc:'',subject:action.payload.subject || '',body:action.payload.body || '',reply_to_id:null,attachments_omitted:!!action.payload.attachments?.length,created_at:new Date().toISOString()}));
        if(drafts.length)setSavedDrafts(existing=>[...drafts,...existing].slice(0,50));
      }
      if (res.pendingActions.length > 0) {
        setPendingActions(prev => [...res.pendingActions, ...prev]);
        setActiveTab('pending');
        setMobileView('workspace'); // Auto-switch to workspace on mobile so user sees the actions
      }

      if (res.auditLogs.length > 0) {
        setAuditLogs(prev => [...res.auditLogs, ...prev]);
      }

      // Only when something in the mailbox changed (a label applied): a proposal changes nothing until approved, and
      // downloading the inbox after every question spent Gmail's per-minute quota. In the background, so the answer
      // appears at once.
      if (res.auditLogs.some(log => log.actionType === 'LABEL_EMAIL')) void refreshEmails();

      return {
        answer: res.finalAnswer,
        steps: res.steps,
        attachmentsUsed: res.pendingActions.some(action=>!!action.payload.attachments?.length)
      };
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApproveAction = async (action: PendingAction) => {
    if(executingActions.current.has(action.id) || attemptedActions.current.has(action.id)) return;
    if(!pendingActions.some(item=>item.id===action.id)) return;
    if(action.payload.sessionKey!==mailProvider.getSessionKey() || action.payload.isReal!==mailProvider.isConnected()){void notify('Esta propuesta pertenece a otra sesión o modo. Recházala y prepara una nueva.');return;}
    if(action.actionType==='SEND_EMAIL' && storageReady && savedDrafts.some(d=>d.id===(action.payload.savedDraftId || action.id))){
      executingActions.current.add(action.id);
      const remaining=savedDrafts.filter(d=>d.id!==(action.payload.savedDraftId || action.id));
      try{await database.current!.save('drafts',remaining);setSavedDrafts(remaining);}
      catch{void notify('No se pudo retirar el borrador de PostgreSQL. No se inició el envío para evitar duplicados. Recarga NexoMail y revisa el estado.');return;}
      finally{executingActions.current.delete(action.id);}
    }
    const isReal = mailProvider.isConnected();
    executingActions.current.add(action.id);attemptedActions.current.add(action.id);
    action=structuredClone(action);
    try {
      if (action.actionType === 'BULK_CLEANUP' || action.actionType === 'DELETE_EMAIL') {
        if (isReal && action.payload.emailIds) {
          await mailProvider.trashEmails(action.payload.emailIds);
        } else if (action.payload.emailIds) {
          emailProvider.trashEmails(action.payload.emailIds);
        }
      } else if (action.actionType === 'RESTORE_EMAIL') {
        if (isReal && action.payload.emailIds) await mailProvider.untrashEmails(action.payload.emailIds);
        else if (action.payload.emailIds) emailProvider.restoreEmails(action.payload.emailIds);
        setFolderEmails(null);
      } else if (action.actionType === 'LABEL_EMAIL') {
        const ids = action.payload.emailIds ?? [];
        const label = action.payload.label ?? 'Trabajo';
        if (isReal && ids.length > 0) {
          await mailProvider.labelEmails(ids, label);
        } else if (ids.length > 0) {
          emailProvider.labelEmails(ids, label);
        }
      } else if (action.actionType === 'SEND_EMAIL') {
        if (isReal && action.payload.recipient && action.payload.subject && action.payload.body) {
          await mailProvider.sendEmail(action.payload.recipient, action.payload.subject, action.payload.body, action.payload.attachments,
            { cc: action.payload.cc, bcc: action.payload.bcc, html: action.payload.bodyHtml });
          recordSent(mailProvider.getSessionKey(), [action.payload.recipient, action.payload.cc, action.payload.bcc].filter(Boolean).join(', '));
        } else {
          emailProvider.addDraftOrSentEmail({
            sender: 'usuario@miempresa.com',
            senderName: 'Usuario Principal',
            recipient: action.payload.recipient || '',
            subject: action.payload.subject || '',
            snippet: action.payload.body?.substring(0, 100) || '',
            body: action.payload.body || '',
            read: true,
            category: 'Trabajo',
            priority: 'high',
            labels: ['Enviado']
          });
        }
      }

      setPendingActions(prev => prev.filter(a => a.id !== action.id));

      setAuditLogs(prev => [
        {
          id: `aud_app_${Date.now()}`,
          timestamp: new Date().toISOString(),
          actionType: action.actionType,
          prompt: `Aprobación manual: ${action.title}`,
          executionStatus: 'HUMAN_APPROVED',
          details: (isReal && action.actionType==='SEND_EMAIL' ? `${MAIL} aceptó el mensaje. La entrega al destinatario sigue sin confirmar.` : `Acción ejecutada en ${isReal ? `${MAIL} real` : 'simulación'}.`) + requestedNote(action),
          userConfirmationTime: new Date().toISOString()
        },
        ...prev
      ]);
    } catch (err: any) {
      // Over the per-minute limit the provider refused the request, so nothing changed: the proposal stays to approve again.
      if (/limitó temporalmente las peticiones/.test(err?.message ?? '')) {
        attemptedActions.current.delete(action.id);
        void notify(`${err.message}

La propuesta sigue en Acciones para que la apruebes de nuevo.`);
        setAuditLogs(prev=>[{id:crypto.randomUUID(),timestamp:new Date().toISOString(),actionType:action.actionType,prompt:action.title,executionStatus:'FAILED',details:`${MAIL} limitó temporalmente las peticiones. No se hizo ningún cambio; la propuesta sigue pendiente.`},...prev]);
        return;
      }
      // The permission failed before the request reached the mail service, so nothing was sent or changed.
      if (err?.authorization === true) {
        attemptedActions.current.delete(action.id);
        void notify(`${ACCOUNT} no renovó el permiso de NexoMail: ${err.message}\n\nNo se envió ni se cambió nada. La propuesta sigue en Acciones para que la apruebes de nuevo.`);
        setAuditLogs(prev=>[{id:crypto.randomUUID(),timestamp:new Date().toISOString(),actionType:action.actionType,prompt:action.title,executionStatus:'FAILED',details:`${ACCOUNT} no renovó el permiso. No se hizo ningún cambio; la propuesta sigue pendiente.`},...prev]);
        return;
      }
      void notify(`No se pudo confirmar la acción: ${err.message}. Revisa ${MAIL} antes de preparar otra propuesta. No se reintentará automáticamente.`);
      setPendingActions(prev=>prev.filter(item=>item.id!==action.id));
      setAuditLogs(prev=>[{id:crypto.randomUUID(),timestamp:new Date().toISOString(),actionType:action.actionType,prompt:action.title,executionStatus:'FAILED',details:'No se pudo confirmar el resultado. Sin reintento automático.'},...prev]);
    } finally {
      executingActions.current.delete(action.id);
    }

    void refreshEmails();
  };

  const handleRejectAction = (action: PendingAction) => {
    setSavedDrafts(list=>list.filter(d=>d.id!==(action.payload.savedDraftId || action.id)));
    setPendingActions(prev => prev.filter(a => a.id !== action.id));

    setAuditLogs(prev => [
      {
        id: `aud_rej_${Date.now()}`,
        timestamp: new Date().toISOString(),
        actionType: action.actionType,
        prompt: `Rechazo manual: ${action.title}`,
        executionStatus: 'HUMAN_REJECTED',
        details: `El usuario canceló la ejecución de ${action.title}. No se realizaron cambios.` + requestedNote(action),
        userConfirmationTime: new Date().toISOString()
      },
      ...prev
    ]);
  };

  const handleMarkRead = async (id: string) => {
    try {
      if (mailProvider.isConnected()) await mailProvider.markAsRead(id);
      else emailProvider.markAsRead(id);
    } catch { return; } // Opening a message never fails because of the read mark.
    patchLocal([id], email => ({ ...email, read: true, labels: email.labels.filter(label => label !== 'UNREAD') }));
  };

  const handleTrash = async (ids: string[]) => {
    try {
      if (mailProvider.isConnected()) await mailProvider.trashEmails(ids);
      else emailProvider.trashEmails(ids);
    } catch (error) {
      void notify(error instanceof Error ? error.message : 'No se pudo mover a la papelera.');
      return;
    }
    patchLocal(ids, () => null);
  };

  const unreadCount = emails.filter(e => !e.read).length;

  const navigation = [
    {id:'inbox',label:'Bandeja de entrada',icon:Mail,count:unreadCount},
    {id:'chat',label:'Chat del agente',icon:Bot,count:0},
    {id:'pending',label:'Acciones pendientes',icon:ShieldAlert,count:pendingActions.length},
    {id:'audit',label:'Auditoría',icon:History,count:0},
    {id:'summary',label:'Resumen general',icon:LayoutDashboard,count:0},
    {id:'settings',label:'Configuración',icon:Settings,count:0},
  ] as const;
  const currentView=mobileView==='chat'?'chat':activeTab;
  function navigate(view:typeof navigation[number]['id']){
    if(view==='chat')setMobileView('chat');
    else{setActiveTab(view);setMobileView('workspace');}
  }
  return (
    <div className={`app-layout outlook-layout ${isFloating?'floating-mode':''} ${isFloating && !isExpanded?'floating-compact':''}`}>
      <Header
        pendingCount={pendingActions.length} totalEmails={emails.length} unreadCount={unreadCount}
        onRefresh={()=>void syncMail()} refreshing={syncing || folderLoading} updatedAt={lastSync} isGmailConnected={isGmailConnected}
        onOpenGmailAuth={()=>{if(isGmailConnected)setIsAuthModalOpen(true);else void authorizeGmail();}} onOpenSettings={()=>navigate('settings')} onOpenPending={()=>navigate('pending')} authorizing={isAuthorizing}
        center={securityAlerts.length>0 && <details className={`insights-summary risk-pop ${dangerousMail.length?'risk-pop-danger':'risk-pop-review'}`}>
          <summary title={dangerousMail.length?'Ver los correos con señales fuertes de fraude':'Ver los correos con detalles que conviene revisar'}><AlertTriangle aria-hidden="true"/>
            {dangerousMail.length
              ? <><span className="lbl-long">{dangerousMail.length===1?'1 correo peligroso':dangerousMail.length+' correos peligrosos'}</span><span className="lbl-short">{dangerousMail.length} peligroso{dangerousMail.length===1?'':'s'}</span></>
              : <><span className="lbl-long">{reviewMail.length===1?'1 correo para revisar':reviewMail.length+' correos para revisar'}</span><span className="lbl-short">{reviewMail.length} para revisar</span></>}
          </summary>
          <div className="risk-pop-panel" role="region" aria-label="Correos con avisos de seguridad">
            {([['Peligrosos','Señales fuertes de fraude o suplantación. No abras sus enlaces ni adjuntos y confirma por otro canal.',dangerousMail],['Para revisar','Detalles que conviene comprobar. No significa que sean peligrosos.',reviewMail]] as const).filter(([, ,list])=>list.length>0).map(([title,hint,list])=><section key={title} className="risk-pop-group">
              <h3>{title} <span>{list.length}</span></h3><p>{hint}</p>
              <ul>{list.map(email=><li key={email.id}><button type="button" className="md-mail-link" onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');openMailFromChat(email.id);}}>{email.subject || '(Sin asunto)'}</button>{email.insights?.sender?.status==='verified'?' · remitente verificado':''}<ul>{email.insights?.reasons.filter(reason=>reason!==email.insights?.sender?.detail).map(reason=><li key={reason}>{reason}</li>)}</ul></li>)}</ul>
            </section>)}
          </div>
        </details>}/>
      {isAuthorizing && <div className="storage-status" role="status">Esperando autorización en {ACCOUNT}…</div>}
      {gmailError && <div className="api-alert-banner" role="alert"><AlertTriangle size={17}/><span>{gmailError}</span><button disabled={isAuthorizing} onClick={()=>void authorizeGmail()} className="workspace-button">Reautorizar con {ACCOUNT}</button></div>}
      {!gmailError && syncNotice && <div className="api-alert-banner sync-notice" role="status"><Clock size={16}/><span>{syncNotice}</span></div>}
      {isStorageProblem(storageStatus) && <div className="storage-status" role="alert"><span>{storageStatus}</span></div>}
      <div className="workspace-shell">
        <aside className="workspace-sidebar" aria-label={`Navegación de ${MAIL}`}>
          <p className="sidebar-caption">GESTIÓN DE CORREO</p>
          <nav>{navigation.map(item=><button type="button" key={item.id} onClick={()=>navigate(item.id)} className={`workspace-nav ${currentView===item.id?'active':''}`} aria-current={currentView===item.id?'page':undefined}><item.icon size={18}/><span>{item.label}</span>{item.count>0 && <span className="workspace-count">{item.count}</span>}</button>)}</nav>
          <div className="workspace-account"><Mail size={17}/><div><strong>{isGmailConnected?`${MAIL} conectado`:(window.emailAgentHost.pageAccount?'Conecta esta cuenta':'Modo de demostración')}</strong><span>{mailProvider.accountEmail() || `Conecta tu cuenta de ${ACCOUNT}`}</span></div></div>
        </aside>
        <main className="workspace-content">
          <section className="workspace-chat" hidden={currentView!=='chat'}>
            <AgentChat active={currentView==='chat'} externalPrompt={agentPrompt} onSendPrompt={handleSendPrompt} isProcessing={isProcessing || storageLoading} restoredMessages={restoredChat} onHistoryChange={saveChat} onOpenMail={openMailFromChat}
              onClearHistory={()=>agentEngine.clearHistory()}/>
          </section>
          <section className="workspace-page" hidden={currentView!=='inbox'}><EmailInbox updatedAt={lastSync?lastSync.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):undefined} automatic={autoGrouping} onAutomaticChange={setAutoGrouping} emails={emails} onMarkRead={handleMarkRead} onTrash={handleTrash} selectedCategory={selectedCategory} onSelectCategory={setSelectedCategory} folder={mailFolder} onSelectFolder={selectFolder} folderEmails={folderEmails} folderLoading={folderLoading} onRefresh={()=>void syncMail()} refreshing={syncing || folderLoading} drafts={savedDrafts} onOpenDraft={draft=>setCompose({to:draft.to,cc:draft.cc,bcc:draft.bcc,subject:draft.subject,body:draftText(draft.body),bodyHtml:draftHtml(draft.body),files:[],draftId:draft.id})} onDiscardDraft={id=>setSavedDrafts(list=>list.filter(d=>d.id!==id))} onCompose={prefill=>setCompose({to:prefill?.to ?? '',subject:prefill?.subject ?? '',body:'',bodyHtml:withSignature(loadSignature(mailProvider.accountEmail())),files:[],replyToSender:prefill?.replyToSender})} onReplyWithAI={replyWithAI} onVerifyByOtherChannel={verifyByOtherChannel} onRestore={handleRestore} onNotSpam={handleNotSpam} onMarkSpam={handleMarkSpam} onSetCategory={handleSetCategory} onListAttachments={listAttachments} onAttachmentFindings={onAttachmentFindings} onDownloadAttachment={downloadAttachment} loadLimit={loadLimit} maxLoaded={MAX_LOADED} onLoadMore={()=>void loadMore()} loadingMore={loadingMore} connected={isGmailConnected} focus={mailFocus}/></section>
          <section className="workspace-page workspace-scroll page-narrow" hidden={currentView!=='pending'}><div className="workspace-section-heading"><ShieldAlert size={21}/><h2>Acciones pendientes</h2><span className="workspace-count">{pendingActions.length}</span></div><p className="pa-intro">Revisa el destinatario y el contenido. Nada se ejecuta hasta que lo apruebes.</p><PendingActionsList pendingActions={pendingActions} onApprove={handleApproveAction} onReject={handleRejectAction} onGoToChat={()=>navigate('chat')} onChange={()=>setPendingActions(list=>[...list])}/></section>
          <section className="workspace-page workspace-scroll page-medium" hidden={currentView!=='audit'}><AuditLogView logs={auditLogs}/></section>
          {(currentView==='summary' || currentView==='settings') && <WorkspacePages storageStatus={storageStatus} storageReady={storageReady} onEraseStorage={eraseStoredData} view={currentView} emails={emails} pendingCount={pendingActions.length} logCount={auditLogs.length} theme={theme} strictMode={strictMode} onToggleTheme={handleToggleTheme} onToggleStrictMode={handleToggleStrictMode} onAuthorize={async()=>{if(isGmailConnected)setIsAuthModalOpen(true);else await authorizeGmail();}} authorizing={isAuthorizing} connected={isGmailConnected} mailCount={mailCount} onMailCount={changeMailCount}/>}
        </main>
      </div>
      <ConfirmHost/>
      <ComposeModal value={compose} onClose={()=>setCompose(null)} onSubmit={submitCompose} onSaveDraft={saveComposeDraft}/>
      <PrivacyConsent open={consentOpen} provider={MAIL} onCancel={()=>setConsentOpen(false)} onAccept={()=>{setConsentOpen(false);void startGmailAuthorization();}}/>
      <GmailAuthModal isOpen={isAuthModalOpen} onClose={()=>setIsAuthModalOpen(false)} onConnect={clientId=>{setIsAuthModalOpen(false);void authorizeGmail(clientId);}} onBeforeDisconnect={()=>database.current?.flush()} onConnectSuccess={()=>{setIsAuthModalOpen(false);setPendingActions([]);agentEngine.clearHistory();refreshEmails();}}/>
    </div>
  );
}
export default App;
