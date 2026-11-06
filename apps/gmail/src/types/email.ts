export type Priority = 'low' | 'normal' | 'high' | 'urgent';

import type { MailInsights } from '@shared/mail/mail-insights';

export type EmailCategory = 'Trabajo' | 'Finanzas' | 'Urgente' | 'Suscripciones' | 'Personal' | 'Notificaciones' | 'Importante' | 'Boletines' | 'Sin clasificar';

export interface Email {
  insights?: MailInsights;
  id: string;
  sender: string;
  senderName: string;
  senderAvatar?: string;
  recipient: string;
  subject: string;
  snippet: string;
  body: string;
  bodyHtml?: string;
  date: string;
  timestamp: number;
  read: boolean;
  category: EmailCategory;
  priority: Priority;
  labels: string[];
  starred?: boolean;
  /** Categories set by hand (Gmail labels), which take precedence over automatic grouping. */
  manualCategories?: string[];
  trashed?: boolean;
  archived?: boolean;
}

export type SafetyLevel = 'SAFE_AUTO' | 'REQUIRES_APPROVAL' | 'BLOCKED';

export type ActionType = 
  | 'LIST_EMAILS' 
  | 'SUMMARIZE_THREAD' 
  | 'DRAFT_REPLY' 
  | 'SEND_EMAIL' 
  | 'DELETE_EMAIL' 
  | 'LABEL_EMAIL' 
  | 'MARK_READ' 
  | 'BULK_CLEANUP'
  | 'RESTORE_EMAIL';

/** A file the person attached in the chat, kept in memory until the message is sent. */
export interface MailFile {
  name: string;
  type: string;
  size: number;
  /** Base64 content, without the data: prefix. */
  data: string;
}

/** Categories a person can assign by hand; stored as Gmail labels with the same name. */
export const MANUAL_CATEGORIES = ['Trabajo', 'Personal', 'Importante', 'Finanzas', 'Boletines'] as const;

export interface ActionPayload {
  savedDraftId?: string;
  emailIds?: string[];
  recipient?: string;
  subject?: string;
  body?: string;
  label?: string;
  reason?: string;
  summaryText?: string;
  isReal?: boolean;
  sessionKey?: string;
  attachments?: MailFile[];
}

export interface PendingAction {
  id: string;
  actionType: ActionType;
  title: string;
  description: string;
  safetyLevel: SafetyLevel;
  payload: ActionPayload;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED';
  createdAt: string;
  aiExplanation: string;
  impactScore: 'Bajo' | 'Medio' | 'Alto' | 'Crítico';
  isEditable?: boolean;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  actionType: ActionType;
  prompt: string;
  executionStatus: 'AUTO_EXECUTED' | 'HUMAN_APPROVED' | 'HUMAN_REJECTED' | 'FAILED';
  details: string;
  userConfirmationTime?: string;
}

export type AgentStep = {
  type: 'THINKING' | 'TOOL_CALL' | 'GUARDRAIL_CHECK' | 'ACTION_CREATED' | 'RESPONSE';
  message: string;
  timestamp: string;
  details?: any;
};
