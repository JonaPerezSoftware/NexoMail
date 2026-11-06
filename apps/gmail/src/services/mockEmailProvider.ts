import type { Email, MailAttachment } from '../types/email';
import { base64ToBlob } from './mailFiles';

export const INITIAL_EMAILS: Email[] = [
  {
    id: 'em-101',
    sender: 'finanzas@banco-global.com',
    senderName: 'Banco Global',
    senderAvatar: undefined,
    recipient: 'usuario@miempresa.com',
    subject: 'URGENTE: Confirmación de transferencia pendiente #9842',
    snippet: 'Estimado cliente, requerimos su autorización para la transferencia internacional por $4,500 USD...',
    body: `Estimado cliente,

Requerimos su autorización inmediata para procesar la transferencia internacional pendiente #9842 por un valor de $4,500.00 USD hacia la cuenta del proveedor Acme Corp.

Por favor ingrese al portal bancario o confirme respondiendo a este mensaje si aprueba la transacción antes de las 18:00 hrs de hoy.

Atentamente,
Departamento de Operaciones
Banco Global`,
    // Demo of deceptive links: the visible address and the real destination differ.
    bodyHtml: '<p>Estimado cliente,</p><p>Requerimos su autorización inmediata para la transferencia pendiente #9842 por $4,500 USD.</p><p>Confirme en <a href="http://banco-global-verificacion.xyz/login">https://www.bancoglobal.com/seguridad</a> o desde este <a href="https://bit.ly/3xYzA1b">enlace rápido</a> antes de las 18:00.</p><p>Consulte nuestras condiciones en <a href="https://www.bancoglobal.com/condiciones">bancoglobal.com/condiciones</a>.</p><p>Atentamente,<br>Departamento de Operaciones</p>',
    date: 'Hoy, 09:30 AM',
    timestamp: Date.now() - 3600000 * 2,
    read: false,
    category: 'Urgente',
    priority: 'urgent',
    labels: ['Finanzas', 'Revisar']
  },
  {
    id: 'em-102',
    sender: 'carlos.mendoza@techpartner.com',
    senderName: 'Carlos Mendoza (TechPartner)',
    senderAvatar: undefined,
    recipient: 'usuario@miempresa.com',
    subject: 'Propuesta de arquitectura Cloud AI y reunión de sincronización',
    snippet: 'Hola! He preparado el documento de arquitectura para el módulo de procesamiento de datos...',
    body: `Hola equipo,

Adjunto la propuesta técnica revisada para la migración del motor de IA a infraestructura serverless. 

¿Tendrías disponibilidad para una breve reunión de sincronización este jueves a las 11:00 AM? Necesitamos definir los entornos de prueba antes del despliegue en staging.

Saludos cordiales,
Carlos Mendoza
Senior Cloud Architect`,
    date: 'Hoy, 10:15 AM',
    timestamp: Date.now() - 3600000 * 1,
    read: false,
    category: 'Trabajo',
    priority: 'high',
    labels: ['Proyecto AI', 'Reunión'],
    hasAttachments: true,
    attachments: [
      { id: 'demo-txt', name: 'propuesta-arquitectura.txt', type: 'text/plain', size: 74, data: 'UHJvcHVlc3RhIGRlIGFycXVpdGVjdHVyYSBDbG91ZCBBSSAoYXJjaGl2byBkZSBkZW1vc3RyYWNpw7NuIGRlIE5leG9NYWlsKS4=' },
      { id: 'demo-png', name: 'diagrama.png', type: 'image/png', size: 68, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
    ]
  },
  {
    id: 'em-103',
    sender: 'newsletter@devweekly.io',
    senderName: 'DevWeekly Digest',
    senderAvatar: undefined,
    recipient: 'usuario@miempresa.com',
    subject: 'DevWeekly #284: Novedades en Agentic AI y TypeScript 5.6',
    snippet: 'En esta edición: cómo construir agentes autónomos con guardrails de seguridad y optimización de promps...',
    body: `DevWeekly Newsletter - Edición #284

En este número:
- La guía definitiva de Agentic AI en entornos corporativos.
- TypeScript 5.6: Optimizaciones de compilación y strictly typed tool calls.
- 5 herramientas clave para seguridad en LLMs.

Haz clic aquí para cancelar tu suscripción si no deseas recibir más correos.`,
    date: 'Ayer, 18:40 PM',
    timestamp: Date.now() - 3600000 * 18,
    read: true,
    category: 'Suscripciones',
    priority: 'low',
    labels: ['Boletín', 'Promociones']
  },
  {
    id: 'em-104',
    sender: 'ofertas@supertienda-online.com',
    senderName: 'SuperTienda Ofertas',
    senderAvatar: undefined,
    recipient: 'usuario@miempresa.com',
    subject: '🔥 50% de Descuento en gadgets y tecnología solo por hoy',
    snippet: 'Aprovecha las ofertas relámpago en teclados mecánicos, monitores 4K y accesorios...',
    body: `¡Ofertas Exclusivas de Verano!

Consigue hasta un 50% de descuento en monitores ergonómicos, audífonos con cancelación de ruido y teclados personalizados.

Descuento aplicable automáticamente en el carrito. Válido hasta medianoche.`,
    date: 'Ayer, 15:20 PM',
    timestamp: Date.now() - 3600000 * 22,
    read: false,
    category: 'Suscripciones',
    priority: 'low',
    labels: ['Spam', 'Descuentos']
  },
  {
    id: 'em-105',
    sender: 'ana.gomez@recursoshumanos.com',
    senderName: 'Ana Gómez (RRHH)',
    senderAvatar: undefined,
    recipient: 'usuario@miempresa.com',
    subject: 'Recordatorio: Actualización de políticas de trabajo remoto Q4',
    snippet: 'Hola a todos, les recordamos actualizar su registro de días presenciales en la plataforma...',
    body: `Estimado equipo,

Les recordamos que a partir de la próxima semana inicia la actualización trimestral de modalidades de trabajo híbrido.

Favor revisar la guía adjunta y confirmar su calendario en el portal interno antes del viernes.

Saludos,
Ana Gómez - RRHH`,
    date: '21 Sep',
    timestamp: Date.now() - 3600000 * 48,
    read: true,
    category: 'Trabajo',
    priority: 'normal',
    labels: ['RRHH', 'Políticas']
  }
];

export class MockEmailService {
  public async listAttachments(email: Email): Promise<MailAttachment[]> { return email.attachments ?? []; }
  public async downloadAttachment(_email: Email, attachment: MailAttachment): Promise<Blob> { return base64ToBlob(attachment.data ?? '', attachment.type); }
  private emails: Email[] = [...INITIAL_EMAILS];

  public getEmails(): Email[] {
    return this.emails.filter(e => !e.trashed);
  }

  public getTrashedEmails(): Email[] {
    return this.emails.filter(e => e.trashed);
  }

  public getEmailById(id: string): Email | undefined {
    return this.emails.find(e => e.id === id);
  }

  public markAsRead(id: string): void {
    const email = this.getEmailById(id);
    if (email) email.read = true;
  }

  public trashEmails(ids: string[]): void {
    this.emails.forEach(e => {
      if (ids.includes(e.id)) {
        e.trashed = true;
      }
    });
  }

  public restoreEmails(ids: string[]): void {
    this.emails.forEach(e => {
      if (ids.includes(e.id)) e.trashed = false;
    });
  }

  public removeLabel(ids: string[], label: string): void {
    this.emails.forEach(e => {
      if (ids.includes(e.id)) e.labels = e.labels.filter(l => l !== label);
    });
  }

  public labelEmails(ids: string[], label: string): void {
    this.emails.forEach(e => {
      if (ids.includes(e.id) && !e.labels.includes(label)) {
        e.labels.push(label);
      }
    });
  }

  public addDraftOrSentEmail(email: Omit<Email, 'id' | 'timestamp' | 'date'>): Email {
    const newEmail: Email = {
      ...email,
      id: `em-${Date.now()}`,
      timestamp: Date.now(),
      date: 'Ahora mismo',
      read: true
    };
    this.emails.unshift(newEmail);
    return newEmail;
  }

  public search(query: string): Email[] {
    const q = query.toLowerCase();
    return this.emails.filter(e => 
      !e.trashed && (
        e.subject.toLowerCase().includes(q) ||
        e.snippet.toLowerCase().includes(q) ||
        e.sender.toLowerCase().includes(q) ||
        e.senderName.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q)
      )
    );
  }
}

export const emailProvider = new MockEmailService();
