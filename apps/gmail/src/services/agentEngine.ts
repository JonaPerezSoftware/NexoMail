import { MAIL, ACCOUNT, MAIL_API } from './platform';
import type { AgentStep, AuditLog, Email, PendingAction } from '../types/email';
import type { ChatMessage } from '../types/llm';
import { emailProvider } from './mockEmailProvider';
import { mailProvider } from './mailProvider';
import { guardrails } from './guardrails';
import { chatWithLlm, fetchLlmHealth } from './llmClient';
import {
  AGENT_TOOL_DEFINITIONS,
  buildInboxContextSummary,
  executeAgentTool,
  type ToolExecutionResult,
} from './agentTools';
import {
  MANUAL_BODY_PLACEHOLDER,
  buildMailSearchQuery,
  describeEmail,
  detectIntent,
  dictatedBody,
  findNamedEmails,
  findReplyTarget,
  firstEmailAddress,
  isBulkCleanupRequest,
  isSentMailRequest,
} from './mailIntent';

export interface AgentResponse {
  steps: AgentStep[];
  pendingActions: PendingAction[];
  finalAnswer: string;
  auditLogs: AuditLog[];
  usedLlm: boolean;
}

const SYSTEM_PROMPT = `Eres EmailAgent AI, un asistente experto en gestión de correo electrónico.
Respondes en español, de forma clara y profesional.

Reglas:
- Usa las herramientas disponibles para leer la bandeja y preparar acciones.
- NUNCA afirmes que enviaste o borraste correos: solo preparas acciones; el usuario debe aprobarlas en el panel.
- Para redactar respuestas, usa prepare_send_email con un cuerpo completo y cortés.
- Para eliminar correos concretos, usa prepare_delete_emails con los ids del contexto. Nunca prepares un envío para cumplir una petición de eliminar.
- Para recuperar correos de la papelera, usa prepare_restore_emails.
- Si no está claro qué correo eliminar o hay varios posibles, pregunta antes de preparar la acción.
- Para limpiar spam/promociones en general, usa prepare_bulk_cleanup (puedes omitir email_ids para auto-selección).
- No inventes destinatarios. Si falta el destinatario, pregúntalo.
- Para etiquetar, usa prepare_label_emails con ids concretos del contexto.
- Si falta información, pregunta al usuario o usa search_emails / get_email_details.
- Sé conciso en la respuesta final al usuario.`;

export class AgentEngine {
  /**
   * Rolling conversation history sent to the LLM for multi-turn context.
   * Capped at MAX_HISTORY_MESSAGES to stay within token limits.
   */
  private conversationHistory: ChatMessage[] = [];
  private static readonly MAX_HISTORY_MESSAGES = 12; // ~20 user/assistant pairs

  /** Clear all conversation memory (e.g. when starting a fresh session) */
  public clearHistory(): void {
    this.conversationHistory = [];
  }

  public restoreTextHistory(messages:{role:'user'|'assistant';content:string}[]):void {
    this.conversationHistory=messages.slice(-AgentEngine.MAX_HISTORY_MESSAGES).map(message=>({role:message.role,content:message.content}));
  }

  /** Trim history to stay within the max limit, preserving the most recent messages */
  private trimHistory(): void {
    if (this.conversationHistory.length > AgentEngine.MAX_HISTORY_MESSAGES) {
      // Keep only the most recent messages
      this.conversationHistory = this.conversationHistory.slice(
        this.conversationHistory.length - AgentEngine.MAX_HISTORY_MESSAGES
      );
    }
  }

  private async getAvailableEmails(): Promise<{ emails: Email[]; isReal: boolean }> {
    if (mailProvider.isConnected()) {
      try {
        const realEmails = await mailProvider.fetchEmails('in:inbox', 15);
        return { emails: realEmails, isReal: true };
      } catch (e) {
        throw new Error(`${MAIL} real no está disponible. Renueva la autorización. No se ha cambiado al simulador.`);
      }
    }
    return { emails: emailProvider.getEmails(), isReal: false };
  }

  private async applyLabels(emailIds: string[], label: string, isReal: boolean) {
    if (isReal) {
      await mailProvider.labelEmails(emailIds, label);
    } else {
      emailProvider.labelEmails(emailIds, label);
    }
  }

  private timestamp() {
    return new Date().toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  private buildAudit(
    actionType: AuditLog['actionType'],
    prompt: string,
    executionStatus: AuditLog['executionStatus'],
    details: string
  ): AuditLog {
    return {
      id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      actionType,
      prompt,
      executionStatus,
      details,
    };
  }

  private async runLlmAgent(
    prompt: string,
    emails: Email[],
    isReal: boolean,
    providerSource: string,
    attachmentNames: string[] = []
  ): Promise<AgentResponse> {
    const steps: AgentStep[] = [];
    const pendingActions: PendingAction[] = [];
    const auditLogs: AuditLog[] = [];

    steps.push({
      type: 'THINKING',
      message: `Modelo LLM analizando la solicitud [${providerSource}]`,
      timestamp: this.timestamp(),
    });

    const inboxContext = buildInboxContextSummary(emails, providerSource);

    // Dynamic system prompt including real-time inbox state
    const systemInstruction = `${SYSTEM_PROMPT}

---
ESTADO ACTUAL DE LA BANDEJA DE ENTRADA:
${inboxContext}`;

    // Clean user message for the current turn
    // The model only sees file names; the files stay in the browser and are attached by the app.
    const currentUserMessage: ChatMessage = {
      role: 'user',
      content: attachmentNames.length
        ? `${prompt}\n\n[El usuario adjuntó: ${attachmentNames.join(', ')}. Se añadirán al correo que prepares con prepare_send_email.]`
        : prompt,
    };

    // Full multi-turn context: updated system prompt + previous turns + current turn
    const messages: ChatMessage[] = [
      { role: 'system', content: systemInstruction },
      ...this.conversationHistory,
      currentUserMessage,
    ];

    const toolCtx = {
      emails,
      isReal,
      providerSource,
      strictMode: guardrails.isStrictMode() || isReal,
      sessionKey: mailProvider.getSessionKey(),
    };

    let finalContent: string | null = null;
    const maxRounds = 5;

    for (let round = 0; round < maxRounds; round++) {
      const llmRes = await chatWithLlm(messages, [...AGENT_TOOL_DEFINITIONS]);
      if(toolCtx.sessionKey!==mailProvider.getSessionKey()) throw new Error('La sesión cambió durante la consulta.');
      const assistantMsg = llmRes.message;

      if (assistantMsg.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: assistantMsg.content,
          tool_calls: assistantMsg.tool_calls,
        });

        for (const call of assistantMsg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args =
              typeof call.function.arguments === 'string'
                ? (JSON.parse(call.function.arguments || '{}') as Record<string, unknown>)
                : ((call.function.arguments || {}) as Record<string, unknown>);
          } catch {
            args = {};
          }

          // A delete request must never turn into an outgoing message, whatever the model chooses.
          const blockedSend = call.function.name === 'prepare_send_email' && detectIntent(prompt) === 'delete';
          const result: ToolExecutionResult = blockedSend
            ? {
                content: JSON.stringify({ error: 'INTENT_MISMATCH', detail: 'El usuario pidió eliminar. Usa prepare_delete_emails o pregunta qué correo eliminar.' }),
                pendingActions: [],
                steps: [{ type: 'GUARDRAIL_CHECK', message: 'prepare_send_email → BLOQUEADO: la petición es eliminar', timestamp: this.timestamp() }],
              }
            : executeAgentTool(call.function.name, args, toolCtx);
          steps.push(...result.steps);
          pendingActions.push(...result.pendingActions);

          if (result.autoLabel) {
            await this.applyLabels(result.autoLabel.emailIds, result.autoLabel.label, isReal);
          }
          if (result.audit) {
            auditLogs.push(
              this.buildAudit(
                result.audit.actionType,
                prompt,
                result.audit.status,
                result.audit.details
              )
            );
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.content,
          });
        }
        continue;
      }

      finalContent = assistantMsg.content;
      break;
    }

    // The reply must match what happened: the model can claim an action it never prepared.
    const claimsPendingAction =
      /(?:revisa|consulta|mira|ve a|aprueba|en)\b.{0,30}acci[oó]n(?:es)?\s+pendientes?/i.test(finalContent ?? '') ||
      /prepar[eé]\s.{0,50}(?:eliminaci[oó]n|env[ií]o|borrador|acci[oó]n)/i.test(finalContent ?? '');
    if (pendingActions.length === 0 && (!finalContent?.trim() || claimsPendingAction)) {
      finalContent =
        'No preparé ninguna acción, así que no hay nada nuevo en Acciones Pendientes. Prueba a indicar con más detalle el correo, el remitente o el destinatario.';
    } else if (!finalContent?.trim()) {
      finalContent = 'Preparé la acción. Revísala en **Acciones Pendientes**: no se ejecutará hasta que la apruebes.';
    }

    if (pendingActions.length > 0) {
      steps.push({
        type: 'RESPONSE',
        message: `${pendingActions.length} acción(es) esperando tu aprobación`,
        timestamp: this.timestamp(),
      });
    }

    // Persist this turn into memory for multi-turn conversational recall
    this.conversationHistory.push(currentUserMessage);
    this.conversationHistory.push({
      role: 'assistant',
      content: finalContent,
    });
    this.trimHistory();

    return {
      steps,
      pendingActions,
      finalAnswer: finalContent,
      auditLogs,
      usedLlm: true,
    };
  }

  /** Fallback sin LLM (keywords) cuando no hay API key o falla la red */
  private async runRuleBasedAgent(
    prompt: string,
    emails: Email[],
    isReal: boolean,
    providerSource: string
  ): Promise<AgentResponse> {
    const toolCtx = {
      emails,
      isReal,
      providerSource,
      strictMode: guardrails.isStrictMode() || isReal,
      sessionKey: mailProvider.getSessionKey(),
    };
    const steps: AgentStep[] = [
      {
        type: 'THINKING',
        message: `Modo local (sin LLM): interpretando "${prompt}"`,
        timestamp: this.timestamp(),
      },
    ];
    const pendingActions: PendingAction[] = [];
    const auditLogs: AuditLog[] = [];
    const lower = prompt.toLowerCase();

    let toolName: string | null = null;
    let args: Record<string, unknown> = {};

    // Replies that need no tool: nothing is proposed, and the reason is stated.
    const answerOnly = (answer: string): AgentResponse => {
      this.conversationHistory.push({ role: 'user', content: prompt });
      this.conversationHistory.push({ role: 'assistant', content: answer });
      this.trimHistory();
      return { steps, pendingActions, finalAnswer: answer, auditLogs, usedLlm: false };
    };
    const intent = detectIntent(prompt);

    if (intent === 'negated') {
      return answerOnly('No preparé ninguna acción. Dime qué quieres hacer con tus correos cuando lo necesites.');
    }

    if (intent === 'restore') {
      const search = findNamedEmails(prompt, emails);
      if (emails.length === 0) {
        return answerOnly('No hay correos en la papelera que coincidan, así que no preparé ninguna recuperación.');
      }
      if (search.missingCriteria) {
        return answerOnly('¿Qué correo quieres recuperar de la papelera? Indica el remitente o el asunto.');
      }
      if (search.matches.length === 0) {
        return answerOnly('No encontré ese correo en la papelera, así que no preparé ninguna recuperación. Prueba con otro remitente o asunto.');
      }
      if (search.matches.length > 1 && !search.wantsAll) {
        const options = search.matches.map((email) => `• ${describeEmail(email)}`).join('\n');
        return answerOnly(`Encontré ${search.matches.length} correos posibles en la papelera y no recuperé ninguno:\n\n${options}\n\nDime el asunto del que quieres recuperar, o pide recuperar todos.`);
      }
      toolName = 'prepare_restore_emails';
      args = { email_ids: search.matches.map((email) => email.id) };
    } else if (intent === 'delete') {
      if (isBulkCleanupRequest(prompt)) {
        toolName = 'prepare_bulk_cleanup';
      } else {
        const search = findNamedEmails(prompt, emails);
        if (search.missingCriteria) {
          return answerOnly('¿Qué correo quieres eliminar? Indica el remitente o el asunto. No elegí ninguno para evitar borrar el equivocado.');
        }
        if (search.matches.length === 0) {
          return answerOnly(`${isReal ? `No encontré ese correo en tu ${MAIL} (recibidos, enviados y archivados; no incluye papelera ni spam)` : `No encontré ese correo entre los ${emails.length} cargados`}, así que no preparé ninguna eliminación. Prueba con otro remitente o asunto.`);
        }
        if (search.matches.length > 1 && !search.wantsAll) {
          const options = search.matches.map((email) => `• ${describeEmail(email)}`).join('\n');
          return answerOnly(`Encontré ${search.matches.length} correos posibles y no eliminé ninguno:\n\n${options}\n\nDime el asunto del que quieres eliminar, o pide eliminar todos.`);
        }
        toolName = 'prepare_delete_emails';
        args = { email_ids: search.matches.map((email) => email.id) };
      }
    } else if (intent === 'send') {
      const address = firstEmailAddress(prompt);
      const replyTo = address
        ? emails.find((email) => email.sender.toLowerCase() === address.toLowerCase())
        : findReplyTarget(prompt, emails);
      const recipient = address || replyTo?.sender;
      if (!recipient) {
        return answerOnly('¿A quién quieres escribir? Indica una dirección de correo o un remitente y asunto de tu bandeja. No usaré un destinatario por defecto.');
      }
      toolName = 'prepare_send_email';
      args = {
        recipient,
        subject: replyTo ? `Re: ${replyTo.subject}` : 'Comunicación vía EmailAgent AI',
        body: `Hola,\n\n${dictatedBody(prompt) ?? MANUAL_BODY_PLACEHOLDER}\n\nSaludos,`,
        ...(replyTo ? { reply_to_email_id: replyTo.id } : {}),
      };
    } else if (
      lower.includes('urgente') ||
      lower.includes('resumen') ||
      lower.includes('resumir') ||
      lower.includes('no leídos')
    ) {
      toolName = 'list_priority_emails';
    } else if (
      lower.includes('limpia') ||
      lower.includes('spam') ||
      lower.includes('suscripciones')
    ) {
      toolName = 'prepare_bulk_cleanup';
    } else if (lower.includes('etiquet') || lower.includes('label')) {
      toolName = 'prepare_label_emails';
      const workIds = emails.filter((e) => e.category === 'Trabajo').map((e) => e.id);
      args = { email_ids: workIds.length ? workIds : emails.slice(0, 2).map((e) => e.id), label: 'Trabajo' };
    } else {
      toolName = 'search_emails';
      args = { query: prompt };
    }

    const result = executeAgentTool(toolName, args, toolCtx);
    steps.push(...result.steps);
    pendingActions.push(...result.pendingActions);
    if (result.autoLabel) {
      await this.applyLabels(result.autoLabel.emailIds, result.autoLabel.label, isReal);
    }
    if (result.audit) {
      auditLogs.push(
        this.buildAudit(result.audit.actionType, prompt, result.audit.status, result.audit.details)
      );
    }

    let finalAnswer = 'Listo. Revisa el panel para más detalles.';
    if (toolName === 'prepare_bulk_cleanup' && pendingActions.length === 0) {
      finalAnswer = 'No encontré promociones, spam ni suscripciones entre los correos cargados, así que no preparé ninguna eliminación.';
    } else if (toolName === 'prepare_restore_emails' && pendingActions.length > 0) {
      finalAnswer = `Preparé la recuperación de **${pendingActions[0].payload.emailIds?.length ?? 0}** correo(s). Apruébala en **Acciones Pendientes** para devolverlos a la bandeja de entrada.`;
    } else if (toolName === 'prepare_delete_emails' && pendingActions.length > 0) {
      finalAnswer = `Preparé la eliminación de **${pendingActions[0].payload.emailIds?.length ?? 0}** correo(s). Revísala en **Acciones Pendientes**: nada se moverá a la papelera hasta que la apruebes.`;
    } else if (toolName === 'prepare_send_email' && pendingActions[0]?.payload.body?.includes(MANUAL_BODY_PLACEHOLDER)) {
      finalAnswer = 'Preparé un borrador. Escribe el mensaje en **Acciones Pendientes**: no se podrá aprobar hasta completarlo.';
    } else if (toolName === 'list_priority_emails') {
      const data = JSON.parse(result.content) as { count: number; emails: string };
      finalAnswer = `Encontré **${data.count}** correo(s) prioritario(s):\n\n${data.emails}`;
    } else if (pendingActions.length > 0) {
      finalAnswer = `Preparé **${pendingActions.length}** acción(es) que requieren tu firma en **Acciones Pendientes**.`;
    } else {
      try {
        const data = JSON.parse(result.content) as { count?: number; results?: unknown[] };
        if (data.count !== undefined) {
          finalAnswer = `Encontré **${data.count}** correo(s) relacionados con tu búsqueda.`;
        }
      } catch {
        /* keep default */
      }
    }

    // Keep memory consistent even in fallback/rule-based mode
    this.conversationHistory.push({ role: 'user', content: prompt });
    this.conversationHistory.push({ role: 'assistant', content: finalAnswer });
    this.trimHistory();

    return { steps, pendingActions, finalAnswer, auditLogs, usedLlm: false };
  }

  public async processPrompt(prompt: string, attachmentNames: string[] = []): Promise<AgentResponse> {
    const sessionKey=mailProvider.getSessionKey();
    const { emails, isReal } = await this.getAvailableEmails();
    if(sessionKey!==mailProvider.getSessionKey())throw new Error('La sesión cambió durante la lectura.');
    const providerSource = isReal
      ? `${MAIL_API} Real (Tu Cuenta Personal)`
      : 'Servidor de Pruebas (Simulado)';

    // Deleting never depends on the model: the named message is found by code and always
    // becomes a real proposal, or a clear answer saying why it did not.
    const intent = detectIntent(prompt);
    if (intent === 'negated') return this.runRuleBasedAgent(prompt, emails, isReal, providerSource);
    if (intent === 'restore') {
      // Recovering mail only looks in the trash, and is resolved by code like deleting.
      try {
        const query = buildMailSearchQuery(prompt);
        const trash = isReal
          ? await mailProvider.fetchEmails(`in:trash ${query ?? ''}`.trim(), 25)
          : emailProvider.getTrashedEmails();
        if (sessionKey !== mailProvider.getSessionKey()) throw new Error('La sesión cambió durante la búsqueda.');
        return this.runRuleBasedAgent(prompt, trash, isReal, providerSource);
      } catch {
        return { steps: [], pendingActions: [], auditLogs: [], usedLlm: false, finalAnswer: `No pude revisar la papelera de ${MAIL} en este momento, así que no preparé ninguna recuperación. Vuelve a intentarlo.` };
      }
    }
    if (intent === 'delete') {
      let pool = emails;
      const query = isReal && !isBulkCleanupRequest(prompt) ? buildMailSearchQuery(prompt) : null;
      if (query) {
        try {
          const found = await mailProvider.fetchEmails(query, 25);
          if (sessionKey !== mailProvider.getSessionKey()) throw new Error('La sesión cambió durante la búsqueda.');
          pool = isSentMailRequest(prompt)
            ? found
            : [...emails, ...found.filter((email) => !emails.some((known) => known.id === email.id))];
        } catch {
          return {
            steps: [],
            pendingActions: [],
            auditLogs: [],
            usedLlm: false,
            finalAnswer: `No pude buscar en tu ${MAIL} en este momento, así que no preparé ninguna eliminación. Vuelve a intentarlo o renueva la autorización de ${ACCOUNT}.`,
          };
        }
      }
      return this.runRuleBasedAgent(prompt, pool, isReal, providerSource);
    }

    const health = await fetchLlmHealth();

    if (health.configured) {
      try {
        return await this.runLlmAgent(prompt, emails, isReal, providerSource, attachmentNames);
      } catch (err) {
        if(sessionKey!==mailProvider.getSessionKey())throw new Error('La sesión cambió. Inicia otra consulta.');
        console.warn('LLM no disponible; se usará el motor de reglas.');
        const fallback = await this.runRuleBasedAgent(prompt, emails, isReal, providerSource);
        fallback.steps.unshift({
          type: 'GUARDRAIL_CHECK',
          message: `LLM no disponible (${err instanceof Error ? err.message : 'error'}). Fallback activado.`,
          timestamp: this.timestamp(),
        });
        return fallback;
      }
    }

    return this.runRuleBasedAgent(prompt, emails, isReal, providerSource);
  }
}

export const agentEngine = new AgentEngine();
