import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Send, Sparkles, ChevronDown, ChevronRight, RotateCcw, AlertTriangle, Paperclip, X, FileText, Image as ImageIcon, ArrowDown, Lightbulb, MessageSquareReply, PenLine, ShieldAlert, Trash2, Loader2 } from 'lucide-react';
import type { AgentStep, MailFile } from '../types/email';
import { parseStamp, messageStamp } from '../services/dates';
import { MessageText } from './MessageText';
import { formatSize, readMailFile } from '../services/mailFiles';
import { CHAT_GREETING, QUICK_ACTIONS as SHARED_QUICK_ACTIONS, type QuickActionId } from '@shared/mail/chat-presets';
import { MAX_ATTACHMENT_BYTES } from '../services/mailProvider';
import { fetchLlmHealth, type LlmHealth } from '../services/llmClient';
import { MAX_ATTACHMENT_LABEL } from '../services/platform';

export interface Message {
  created_at?:string;
  id: string;
  sender: 'user' | 'agent';
  text: string;
  timestamp: string;
  steps?: AgentStep[];
}

interface AgentChatProps {
  onSendPrompt: (prompt: string, files: MailFile[]) => Promise<{ answer: string; steps: AgentStep[]; attachmentsUsed?: boolean }>;
  isProcessing: boolean;
  restoredMessages?: Message[] | null;
  onHistoryChange?: (messages:Message[])=>void;
  onClearHistory?: () => void;
  /** Opens a mail the answer links to, in the Correo tab. */
  onOpenMail?: (id: string) => void;
  /** True while the chat is on screen; it jumps to the latest message every time it is shown. */
  active?: boolean;
  /** A prompt sent from elsewhere in the app, such as «Responder con IA» in the mail tab. */
  externalPrompt?: { id: string; text: string } | null;
}

interface QuickAction {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  prompt: string;
}

/** Same requests and greeting as the Outlook chat. */
const QUICK_ICONS: Record<QuickActionId, React.ComponentType<{ className?: string }>> = { briefing: Sparkles, awaiting: MessageSquareReply, reply: PenLine, risks: ShieldAlert, cleanup: Trash2 };
const QUICK_ACTIONS: QuickAction[] = SHARED_QUICK_ACTIONS.map(action => ({ icon: QUICK_ICONS[action.id], label: action.label, prompt: action.prompt }));

function formatModelDetails(llmHealth: LlmHealth | null) {
  if (!llmHealth || !llmHealth.configured) {
    return {
      full: 'Motor de reglas (sin IA)',
      compact: 'Motor de reglas',
      short: 'Local',
      provider: 'Motor Local',
      isConfigured: false,
      isOllama: false,
      isReachable: true,
      tooltip: 'Ejecutando en modo local seguro sin API key externa'
    };
  }

  const rawModel = llmHealth.model || 'Modelo IA';
  const provider = llmHealth.provider || 'LLM';
  const isOllama = Boolean(llmHealth.isOllama || provider.toLowerCase().includes('ollama'));
  const isReachable = llmHealth.reachable !== false;

  // Format clean human-readable version
  let compact = rawModel;
  if (rawModel.includes('gemini-3.8-flash')) compact = 'Gemini 3.8 Flash';
  else if (rawModel.includes('gemini-2.0-flash')) compact = 'Gemini 2.0 Flash';
  else if (rawModel.includes('gemini-1.5-flash')) compact = 'Gemini 1.5 Flash';
  else if (rawModel.includes('gemini-1.5-pro')) compact = 'Gemini 1.5 Pro';
  else if (rawModel.includes('gpt-4o-mini')) compact = 'GPT-4o mini';
  else if (rawModel.includes('gpt-4o')) compact = 'GPT-4o';
  else if (rawModel.includes('claude-3-5')) compact = 'Claude 3.5 Sonnet';
  else if (rawModel.includes('llama3.2')) compact = 'Llama 3.2';
  else if (rawModel.includes('llama3.1')) compact = 'Llama 3.1';
  else if (rawModel.includes('llama3.3')) compact = 'Llama 3.3';
  else if (rawModel.includes('qwen3')) compact = 'Qwen 3 4B';
  else if (rawModel.includes('qwen2.5')) compact = 'Qwen 2.5';
  else if (rawModel.includes('qwen')) compact = 'Qwen';
  else if (rawModel.includes('mistral')) compact = 'Mistral';
  else if (rawModel.includes('deepseek')) compact = 'DeepSeek R1';

  let full = `${provider} · ${compact}`;
  if (isOllama) {
    full = isReachable ? `Ollama Local · ${compact}` : `Ollama (Off) · ${compact}`;
    compact = isReachable ? `${compact} (Local)` : `${compact} (Off)`;
  }

  const tooltip = isOllama
    ? isReachable
      ? `Ollama Local (Sin costo de tokens) | Modelo: ${rawModel} | Procesamiento local`
      : `Ollama no responde en http://localhost:11434. Asegúrate de ejecutar 'ollama serve'.`
    : `Proveedor: ${provider} | Modelo: ${rawModel} | Guardrails Activos`;

  return {
    full,
    compact,
    short: compact.split(' ')[0] || compact,
    provider: isOllama ? 'Ollama Local' : provider,
    isConfigured: true,
    isOllama,
    isReachable,
    tooltip
  };
}

const TOOL_NAMES: Record<string, string> = {
  list_priority_emails: 'Revisar correos prioritarios',
  search_emails: 'Buscar correos',
  get_email_details: 'Leer un correo',
  prepare_send_email: 'Preparar un envío',
  prepare_delete_emails: 'Preparar el paso a la papelera',
  prepare_restore_emails: 'Preparar una recuperación',
  prepare_bulk_cleanup: 'Preparar una limpieza',
  prepare_label_emails: 'Preparar un etiquetado',
};

const isFallbackStep = (step: AgentStep) => step.type === 'GUARDRAIL_CHECK' && /fallback|no disponible/i.test(step.message);

/** Turns the engine's technical trace into short sentences a person can follow. */
function describeStep(step: AgentStep): { label: string; text: string; tone: string } {
  const tool = step.details?.tool as string | undefined;
  const args = (step.details?.args ?? {}) as Record<string, unknown>;
  switch (step.type) {
    case 'TOOL_CALL': {
      const name = (tool && TOOL_NAMES[tool]) || tool || 'Herramienta';
      const ids = Array.isArray(args.email_ids) ? args.email_ids.length : 0;
      const detail = typeof args.query === 'string' ? `«${args.query}»`
        : typeof args.recipient === 'string' ? `para ${args.recipient}`
        : ids ? `${ids} correo${ids === 1 ? '' : 's'}` : '';
      return { label: 'Herramienta', text: detail ? `${name} · ${detail}` : name, tone: 'tool' };
    }
    case 'GUARDRAIL_CHECK': {
      if (isFallbackStep(step)) {
        const code = step.message.match(/HTTP (\d{3})/)?.[1];
        return { label: 'Motor de reglas', text: `La IA no respondió${code ? ` (error ${code})` : ''}, así que se usó el motor de reglas local.`, tone: 'warn' };
      }
      if (/BLOQUEADO/i.test(step.message)) return { label: 'Bloqueado', text: step.message.replace(/^.*?BLOQUEADO:?\s*/i, '').replace(/^\(|\)$/g, '') || 'La acción no cumplió las reglas de seguridad.', tone: 'warn' };
      if (/REQUIRES_APPROVAL/.test(step.message)) return { label: 'Seguridad', text: 'Requiere tu aprobación antes de ejecutarse.', tone: 'check' };
      if (/SAFE_AUTO/.test(step.message)) return { label: 'Seguridad', text: 'Solo lectura: no cambia ningún correo.', tone: 'check' };
      return { label: 'Seguridad', text: step.message, tone: 'check' };
    }
    case 'THINKING':
      return { label: 'Análisis', text: /Modo local/i.test(step.message) ? 'Interpretando tu petición con reglas locales.' : 'Interpretando tu petición con la IA.', tone: 'think' };
    case 'ACTION_CREATED':
      return { label: 'Propuesta', text: 'Creada y enviada a Acciones para que la revises.', tone: 'action' };
    default:
      return { label: 'Respuesta', text: step.message, tone: 'think' };
  }
}

export const AgentChat: React.FC<AgentChatProps> = ({ onSendPrompt, isProcessing, active = true, externalPrompt, onClearHistory, restoredMessages, onHistoryChange, onOpenMail }) => {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<MailFile[]>([]);
  const [fileError, setFileError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const filesSize = files.reduce((sum, file) => sum + file.size, 0);

  /** Files are read in the browser and travel only with the approved message; the AI sees just their names. */
  const addFiles = async (list: FileList | null) => {
    setFileError('');
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    try {
      const read = await Promise.all(picked.map(readMailFile));
      // Checked after reading, so reduced photos count with their new size.
      if (filesSize + read.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) { setFileError(`Los adjuntos superan ${MAX_ATTACHMENT_LABEL} en total. Quita alguno o envía un enlace.`); return; }
      setFiles(prev => [...prev, ...read]);
    } catch (error) {
      setFileError(`No se pudo leer ${error instanceof Error ? error.message : 'el archivo'}.`);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const [llmHealth, setLlmHealth] = useState<LlmHealth | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});

  const initialMessage: Message = {
    id: 'm-1',
    sender: 'agent',
    text: CHAT_GREETING,
    created_at: new Date().toISOString(),
    timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  };

  const [messages, setMessages] = useState<Message[]>([initialMessage]);
  useEffect(()=>{
    if(restoredMessages!==null && restoredMessages!==undefined){
      const nonGreetings=restoredMessages.filter(m=>!m.id.startsWith('m-') && m.id!=='m-1');
      setMessages(nonGreetings.length?[initialMessage,...nonGreetings]:[initialMessage]);
    }
  },[restoredMessages]);
  useEffect(()=>{onHistoryChange?.(messages);},[messages]);

  useEffect(() => {
    fetchLlmHealth().then(setLlmHealth);
  }, []);

  const modelInfo = formatModelDetails(llmHealth);
  const userTurnCount = messages.filter(m => m.sender === 'user').length;
  // A quiet reminder under the latest answer only, and only when the AI wrote it (not the greeting or the rules engine).
  const lastAgent = [...messages].reverse().find(m => m.sender === 'agent');
  const aiNoteFor = modelInfo.isConfigured && lastAgent?.steps?.length && !lastAgent.steps.some(isFallbackStep) ? lastAgent.id : null;
  const scrollArea = useRef<HTMLDivElement>(null);
  /** Suggested requests stay available after the conversation starts, behind a button next to the input. */
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestRef = useRef<HTMLDivElement>(null);
  const suggestButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!suggestOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!suggestRef.current?.contains(target) && !suggestButton.current?.contains(target)) setSuggestOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setSuggestOpen(false); suggestButton.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    suggestRef.current?.querySelector('button')?.focus();
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [suggestOpen]);
  /** Shown once the person has scrolled away from the latest message. */
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const checkScroll = () => {
    const area = scrollArea.current;
    if (area) setAwayFromEnd(area.scrollHeight - area.scrollTop - area.clientHeight > 160);
  };
  const scrollToEnd = () => {
    const area = scrollArea.current;
    if (!area) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    area.scrollTo({ top: area.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  };
  useLayoutEffect(() => {
    if (!active) return;
    const area = scrollArea.current;
    if (!area) return;
    area.scrollTop = area.scrollHeight;
    // Restored history and fonts can change the height right after the first paint.
    const frame = requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; setAwayFromEnd(false); });
    return () => cancelAnimationFrame(frame);
  }, [active, messages.length, isProcessing]);

  const handleClear = () => {
    if (isProcessing) return;
    setMessages([
      {
        ...initialMessage,
        id: `m-${Date.now()}`,
        created_at: new Date().toISOString(),
        timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      }
    ]);
    setExpandedSteps({});
    onClearHistory?.();
  };

  const toggleSteps = (msgId: string) => {
    setExpandedSteps(prev => ({
      ...prev,
      [msgId]: !prev[msgId]
    }));
  };

  const handledPrompt = useRef<string | null>(null);
  useEffect(() => {
    if (!externalPrompt || handledPrompt.current === externalPrompt.id || isProcessing) return;
    handledPrompt.current = externalPrompt.id;
    void handleSend(externalPrompt.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrompt, isProcessing]);

  const handleSend = async (textToSend?: string) => {
    const promptText = textToSend || input;
    if (!promptText.trim() || isProcessing) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),created_at:new Date().toISOString(),
      sender: 'user',
      text: promptText,
      timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMsg]);
    if (!textToSend) setInput('');

    try {
      const attached = textToSend ? [] : files;
      const res = await onSendPrompt(promptText, attached);
      if (res.attachmentsUsed) setFiles([]);
      const agentMsg: Message = {
        id: crypto.randomUUID(),created_at:new Date().toISOString(),
        sender: 'agent',
        text: res.answer,
        timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        steps: res.steps
      };
      setMessages(prev => [...prev, agentMsg]);
    } catch (err) {
      console.error(err);
      const reason = err instanceof Error && err.message ? err.message : 'Error desconocido.';
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), created_at: new Date().toISOString(), sender: 'agent',
        text: `No pude completar la consulta: ${reason}

No se preparó ninguna acción. Vuelve a intentarlo en unos segundos.`,
        timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      }]);
    }
  };

  return (
    <div className="chat-container">
      {llmHealth?.isOllama && llmHealth?.warning && (
        <div className="ollama-notice-banner" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{llmHealth.warning}</span>
        </div>
      )}

      <div className="chat-messages" ref={scrollArea} onScroll={checkScroll}>
        {messages.map(msg => {
          const isStepsExpanded = expandedSteps[msg.id] ?? false;
          return (
            <div key={msg.id} className={`chat-bubble-wrapper ${msg.sender}`}>
              <div className="bubble-content">
                {/* Reasoning trace disclosure */}
                {msg.steps && msg.steps.length > 0 && (
                  <div className="trace">
                    <button
                      type="button"
                      onClick={() => toggleSteps(msg.id)}
                      className="trace-toggle"
                      aria-expanded={isStepsExpanded}
                    >
                      {isStepsExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                      <span>Cómo lo resolvió</span>
                      <span className="trace-count">{msg.steps.length} {msg.steps.length === 1 ? 'paso' : 'pasos'}</span>
                      {msg.steps.some(isFallbackStep) && <span className="trace-flag">Sin IA</span>}
                    </button>

                    {isStepsExpanded && (
                      <ol className="trace-steps">
                        {msg.steps.map((step, idx) => {
                          const view = describeStep(step);
                          return (
                            <li key={idx} className={`trace-step trace-${view.tone}`}>
                              <span className="trace-dot" aria-hidden="true" />
                              <div className="trace-body">
                                <span className="trace-label">{view.label}</span>
                                <span className="trace-text">{view.text}</span>
                              </div>
                              <time className="trace-time">{step.timestamp.slice(0, 5)}</time>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                )}

                <MessageText text={msg.text} onOpenMail={onOpenMail} />

                {(() => { const date = parseStamp(msg.created_at); return date
                  ? <time className="message-time" dateTime={date.toISOString()} title={date.toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'short' })}>{messageStamp(date)}</time>
                  : <span className="message-time">{msg.timestamp}</span>; })()}
                {msg.id === aiNoteFor && !isProcessing && <p className="chat-ai-note">NexoMail es una IA y puede cometer errores.</p>}
              </div>
            </div>
          );
        })}

        {isProcessing && (
          <div className="chat-bubble-wrapper agent">
            <div className="bubble-content">
              <div className="chat-working">
                <span>Ejecutando guardrails y procesando consulta...</span>
              </div>
            </div>
          </div>
        )}

        {userTurnCount === 0 && !isProcessing && !suggestOpen && (
          <div className="quick-prompts">
            {QUICK_ACTIONS.map((action, idx) => {
              const Icon = action.icon;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSend(action.prompt)}
                  className="chip-prompt"
                  title={action.prompt}
                >
                  <Icon className="w-3.5 h-3.5 chip-icon" />
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="chat-jump-anchor">{awayFromEnd && <button type="button" className="chat-jump" onClick={scrollToEnd} aria-label="Ir al último mensaje" title="Ir al último mensaje"><ArrowDown aria-hidden="true"/></button>}</div>

      {(files.length > 0 || fileError) && (
        <div className="chat-files" aria-live="polite">
          {files.map((file, index) => (
            <span key={index} className="chat-file">
              {file.type.startsWith('image/') ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
              <span className="chat-file-name">{file.name}</span>
              <span className="chat-file-size">{file.originalSize ? <span title="Foto reducida para enviarla más rápido">{formatSize(file.originalSize)} → {formatSize(file.size)}</span> : formatSize(file.size)}</span>
              <button type="button" onClick={() => setFiles(prev => prev.filter((_, i) => i !== index))} aria-label={`Quitar ${file.name}`}><X aria-hidden="true" /></button>
            </span>
          ))}
          {fileError && <span className="chat-file-error" role="alert">{fileError}</span>}
        </div>
      )}

      {suggestOpen && (
        <div className="chat-suggest" id="chat-suggest" ref={suggestRef} role="group" aria-label="Sugerencias">
          <span className="chat-suggest-title">Sugerencias</span>
          <div className="chat-suggest-list">
            {QUICK_ACTIONS.map((action, idx) => {
              const Icon = action.icon;
              return (
                <button key={idx} type="button" className="chip-prompt" title={action.prompt} disabled={isProcessing}
                  onClick={() => { setSuggestOpen(false); handleSend(action.prompt); }}>
                  <Icon className="w-3.5 h-3.5 chip-icon" />
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="chat-input-area">
        <button
          ref={suggestButton}
          type="button"
          onClick={() => setSuggestOpen(open => !open)}
          disabled={isProcessing}
          className="attach-button suggest-button"
          aria-expanded={suggestOpen}
          aria-controls="chat-suggest"
          title="Sugerencias de acciones"
          aria-label="Sugerencias de acciones"
        >
          <Lightbulb aria-hidden="true" />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={e => void addFiles(e.target.files)} />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={isProcessing}
          className="attach-button"
          title="Adjuntar archivos o imágenes al correo que prepare el agente"
          aria-label="Adjuntar archivos"
        >
          <Paperclip aria-hidden="true" />
        </button>
        <input
          type="text"
          value={input}
          disabled={isProcessing}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder={files.length ? "¿A quién envío los archivos?" : "Escribe una instrucción…"}
          className="chat-input"
          aria-label="Mensaje para el agente"
        />
        <button
          onClick={() => handleSend()}
          disabled={isProcessing || !input.trim()}
          className="send-button"
          title="Enviar instrucción (Enter)"
          aria-label={isProcessing ? 'Procesando tu consulta' : 'Enviar'}
          aria-busy={isProcessing}
        >
          {isProcessing ? <Loader2 className="w-4 h-4 spin" aria-hidden="true" /> : <Send className="w-4 h-4" />}
        </button>
      </div>

      <div className="chat-meta">
        <span className="chat-meta-engine" title={modelInfo.tooltip}>
          <span className={`status-dot ${modelInfo.isConfigured ? 'active' : 'warning'}`} />
          {modelInfo.provider}: {modelInfo.compact}
          {userTurnCount > 0 && <> · Memoria: {userTurnCount} {userTurnCount === 1 ? 'mensaje' : 'mensajes'}</>}
        </span>
        {userTurnCount > 0 && (
          <button
            type="button"
            onClick={handleClear}
            disabled={isProcessing}
            className="chat-meta-reset"
            title="Reiniciar conversación y limpiar memoria del agente"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Nueva conversación
          </button>
        )}
      </div>
    </div>
  );
};
