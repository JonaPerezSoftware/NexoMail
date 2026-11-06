/** Greeting and suggested requests shared by the Gmail and Outlook chats, so both read the same. */
export const CHAT_GREETING =
  '¡Hola! Soy tu **Agente de IA para Gestión de Correo**. Puedo leer, clasificar, redactar y ejecutar acciones en lenguaje natural.\n\n' +
  'Recuerdo el contexto de nuestra conversación y todas las acciones sensibles requieren tu autorización.';

export type QuickActionId = 'briefing' | 'awaiting' | 'reply' | 'risks' | 'cleanup';

/**
 * The requests that save the most time. Each prompt is worded so the agent routes it the same way
 * with or without AI: briefing, awaiting and risks are computed from the mail; reply and cleanup
 * only prepare proposals that wait for approval.
 */
export const QUICK_ACTIONS: { id: QuickActionId; label: string; prompt: string }[] = [
  { id: 'briefing', label: 'Resumen del día', prompt: 'Dame el resumen del día de mi bandeja' },
  { id: 'awaiting', label: 'Por responder', prompt: '¿Qué correos están esperando mi respuesta?' },
  { id: 'reply', label: 'Responder al último', prompt: 'Redacta una respuesta al último correo que me escribió una persona' },
  { id: 'risks', label: 'Revisar sospechosos', prompt: '¿Tengo correos sospechosos o de phishing?' },
  { id: 'cleanup', label: 'Limpiar promociones', prompt: 'Limpia mi bandeja: mueve a la papelera las promociones y suscripciones' },
];
