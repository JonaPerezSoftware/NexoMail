/** Greeting and suggested requests shared by the Gmail and Outlook chats, so both read the same. */
export const CHAT_GREETING =
  '¡Hola! Soy tu **Agente de IA para Gestión de Correo**. Puedo leer, clasificar, redactar y ejecutar acciones en lenguaje natural.\n\n' +
  'Recuerdo el contexto de nuestra conversación y todas las acciones sensibles requieren tu autorización.';

export type QuickActionId = 'urgent' | 'unread' | 'reply' | 'label';

/** Each prompt is worded so both rule engines route it correctly, with or without AI. */
export const QUICK_ACTIONS: { id: QuickActionId; label: string; prompt: string }[] = [
  { id: 'urgent', label: 'Resumir urgentes', prompt: 'Hazme un resumen de los correos urgentes de hoy' },
  { id: 'unread', label: 'Resumir no leídos', prompt: 'Resume mis correos no leídos' },
  { id: 'reply', label: 'Redactar respuesta', prompt: 'Redacta una respuesta al correo seleccionado' },
  { id: 'label', label: 'Etiquetar trabajo', prompt: 'Etiqueta como Trabajo los correos sin leer del proyecto' },
];
