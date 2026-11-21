import type { ChatMessage } from '../types/llm';

export type LlmHealth = {
  configured: boolean;
  model: string | null;
  provider: string | null;
  isOllama?: boolean;
  reachable?: boolean;
  warning?: string | null;
  availableModels?: string[];
};

export type LlmChatResult = {
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
    /** Claude only: the original blocks (with its reasoning) to send back in the next round of the same turn. */
    anthropic_content?: unknown[];
  };
  model: string;
  /** Claude only: tokens read, from cache and written, to show where the time goes. */
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

/** The AI the person chose in Ajustes or in the chat footer. null: the server's default (LLM_PROVIDER). */
export type ProviderId = 'anthropic' | 'gemini';
export type ProviderOption = { id: ProviderId; label: string; model: string; configured: boolean; note: string };
export const PROVIDER_EVENT = 'nexomail:provider-changed';
let chosenProvider: ProviderId | null = null;
let choiceAccount = '';
const choiceKey = (account: string) => 'nexomail.llmProvider:' + (account.toLowerCase() || 'sin-cuenta');
export function selectedProvider(): ProviderId | null { return chosenProvider; }
/** Reads the choice saved in this browser for the account (each account keeps its own). */
export function loadProviderChoice(account: string): void {
  choiceAccount = account;
  let saved: string | null = null;
  try { saved = localStorage.getItem(choiceKey(account)); } catch { /* storage unavailable: the server default is used */ }
  chosenProvider = saved === 'anthropic' || saved === 'gemini' ? saved : null;
  window.dispatchEvent(new CustomEvent(PROVIDER_EVENT, { detail: chosenProvider }));
}
export function chooseProvider(id: ProviderId): void {
  chosenProvider = id;
  try { localStorage.setItem(choiceKey(choiceAccount), id); } catch { /* kept for this session only */ }
  window.dispatchEvent(new CustomEvent(PROVIDER_EVENT, { detail: id }));
}
/** The options the server can offer (only those with a key in backend/.env can be used). */
export async function fetchProviders(): Promise<{ default: string; options: ProviderOption[] } | null> {
  try {
    const res = await fetch(window.emailAgentHost.config.apiBaseUrl + '/api/gmail/agent/providers', { headers: { 'X-EmailAgent-Token': window.emailAgentHost.config.pairingToken }, signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function fetchLlmHealth(): Promise<LlmHealth> {
  try {
    const query = chosenProvider ? '?provider=' + chosenProvider : '';
    const res = await fetch(window.emailAgentHost.config.apiBaseUrl+'/api/gmail/agent/health'+query,{headers:{'X-EmailAgent-Token':window.emailAgentHost.config.pairingToken},signal:AbortSignal.timeout(8000)});
    if (!res.ok) {
      return { configured: false, model: null, provider: null };
    }
    return (await res.json()) as LlmHealth;
  } catch {
    return { configured: false, model: null, provider: null };
  }
}

/**
 * Same as chatWithLlm, but the answer arrives while the model writes it: onText receives each new piece of text.
 * The server sends one JSON object per line (text pieces, then «done» with the full result, or «error»).
 */
export async function chatWithLlmStream(
  messages: ChatMessage[],
  tools: unknown[],
  onText: (piece: string) => void
): Promise<LlmChatResult> {
  const res = await fetch(window.emailAgentHost.config.apiBaseUrl + '/api/gmail/agent/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EmailAgent-Token': window.emailAgentHost.config.pairingToken },
    body: JSON.stringify({ messages, tools, ...(chosenProvider ? { provider: chosenProvider } : {}) }),
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string; detail?: string };
    throw new Error(err.message || err.detail || err.error || `LLM HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const out: { result: LlmChatResult | null } = { result: null };
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type: string; text?: string; result?: LlmChatResult; detail?: string; status?: number };
    if (event.type === 'text' && event.text) onText(event.text);
    else if (event.type === 'done' && event.result) out.result = event.result;
    else if (event.type === 'error') throw new Error(event.detail || `LLM HTTP ${event.status ?? 502}`);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  handle(buffer + decoder.decode());
  if (!out.result) throw new Error('La respuesta de la IA se cortó antes de terminar. Inténtalo de nuevo.');
  return out.result;
}

/** Text the assistant is writing right now, for the chat to show before the answer is complete. */
export const PARTIAL_EVENT = 'nexomail:partial-answer';
export function announcePartial(text: string | null): void {
  window.dispatchEvent(new CustomEvent(PARTIAL_EVENT, { detail: text }));
}

export async function chatWithLlm(
  messages: ChatMessage[],
  tools: unknown[]
): Promise<LlmChatResult> {
  const res = await fetch(window.emailAgentHost.config.apiBaseUrl+'/api/gmail/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json','X-EmailAgent-Token':window.emailAgentHost.config.pairingToken },
    body: JSON.stringify({ messages, tools, ...(chosenProvider ? { provider: chosenProvider } : {}) }),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = data as { error?: string; message?: string;detail?: string };
    throw new Error(err.message || err.detail || err.error || `LLM HTTP ${res.status}`);
  }

  return data as LlmChatResult;
}
