import { MANUAL_BODY_PLACEHOLDER } from '../services/mailIntent';
import React, { useRef, useState } from 'react';
import { Check, X, Mail, Trash2, Tag, Info, PenLine, ShieldCheck, Undo2, Paperclip, MessageSquare, FileText, Image as ImageIcon, Loader2, History } from 'lucide-react';
import type { ActionType, MailFile, PendingAction } from '../types/email';
import { MAIL, PLATFORM, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL } from '../services/platform';

import { formatSize, readMailFile } from '../services/mailFiles';

interface PendingActionsListProps {
  pendingActions: PendingAction[];
  onApprove: (action: PendingAction) => void | Promise<void>;
  onReject: (action: PendingAction) => void;
  onGoToChat?: () => void;
  /** Called after the person edits a proposal or changes its selection, so it is saved. */
  onChange?: () => void;
}

/** One visual language per kind of action: icon, label and the verb on the confirm button. */
const KIND: Partial<Record<ActionType, { icon: typeof Mail; label: string; confirm: string; working: string; tone: 'send' | 'danger' | 'neutral' }>> = {
  SEND_EMAIL: { icon: Mail, label: 'Enviar correo', confirm: 'Enviar', working: 'Enviando…', tone: 'send' },
  DELETE_EMAIL: { icon: Trash2, label: 'Mover a la papelera', confirm: 'Mover a la papelera', working: 'Moviendo a la papelera…', tone: 'danger' },
  BULK_CLEANUP: { icon: Trash2, label: 'Limpieza de correos', confirm: 'Mover a la papelera', working: 'Moviendo a la papelera…', tone: 'danger' },
  LABEL_EMAIL: { icon: Tag, label: 'Aplicar etiqueta', confirm: 'Aplicar etiqueta', working: 'Etiquetando…', tone: 'neutral' },
  RESTORE_EMAIL: { icon: Undo2, label: 'Recuperar de la papelera', confirm: 'Recuperar', working: 'Recuperando…', tone: 'neutral' },
};
const FALLBACK_KIND = { icon: Info, label: 'Acción propuesta', confirm: 'Aprobar', working: 'Aplicando…', tone: 'neutral' as const };

export const PendingActionsList: React.FC<PendingActionsListProps> = ({
  pendingActions,
  onApprove,
  onReject,
  onGoToChat,
  onChange
}) => {
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ recipient: string; subject: string; body: string; files: MailFile[] }>({
    recipient: '',
    subject: '',
    body: '',
    files: []
  });
  const [fileError, setFileError] = useState('');
  // Ticking a message changes the proposal in place; this only asks React to redraw.
  const [, redrawState] = useState(0);
  const redraw = (update: (n: number) => number) => { redrawState(update); onChange?.(); };
  /** The proposal being executed: its buttons stay disabled and show what is happening. */
  const [working, setWorking] = useState<string | null>(null);
  const approve = async (action: PendingAction) => {
    if (working) return;
    setWorking(action.id);
    try { await onApprove(action); } finally { setWorking(null); }
  };
  const toggleEmail = (action: PendingAction, id: string) => {
    const selected = new Set(action.payload.emailIds ?? []);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    action.payload.emailIds = (action.payload.emailOptions ?? []).map((option) => option.id).filter((optionId) => selected.has(optionId));
    redraw((n) => n + 1);
  };
  const setAllEmails = (action: PendingAction, all: boolean) => {
    action.payload.emailIds = all ? (action.payload.emailOptions ?? []).map((option) => option.id) : [];
    redraw((n) => n + 1);
  };
  const fileInput = useRef<HTMLInputElement>(null);

  /** Same limits as the chat and the compose dialog; files stay in memory until the send is approved. */
  const addFiles = async (list: FileList | null) => {
    setFileError('');
    const picked = [...(list ?? [])];
    try {
      const read = await Promise.all(picked.map(readMailFile));
      if (editForm.files.reduce((sum, file) => sum + file.size, 0) + read.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) { setFileError(`Los adjuntos superan ${MAX_ATTACHMENT_LABEL} en total.`); return; }
      setEditForm(prev => ({ ...prev, files: [...prev.files, ...read] }));
    } catch (error) { setFileError(`No se pudo leer ${error instanceof Error ? error.message : 'el archivo'}.`); }
    finally { if (fileInput.current) fileInput.current.value = ''; }
  };

  if (pendingActions.length === 0) {
    return (
      <div className="pa-empty">
        <ShieldCheck aria-hidden="true" />
        <h3>No hay acciones pendientes</h3>
        <p>Pídele al asistente que redacte, clasifique u organice correos y sus propuestas aparecerán aquí.</p>
        {onGoToChat && <button type="button" className="pa-btn pa-btn-secondary" onClick={onGoToChat}><MessageSquare aria-hidden="true" />Ir al chat</button>}
      </div>
    );
  }

  const handleStartEdit = (action: PendingAction) => {
    setEditingActionId(action.id);
    setEditForm({
      recipient: action.payload.recipient || '',
      subject: action.payload.subject || '',
      body: action.payload.body || '',
      files: [...(action.payload.attachments ?? [])]
    });
    setFileError('');
  };

  const handleSaveEdit = (action: PendingAction) => {
    action.payload.recipient = editForm.recipient;
    action.payload.subject = editForm.subject;
    action.payload.body = editForm.body;
    action.payload.attachments = editForm.files.length ? editForm.files : undefined;
    action.title = `Enviar correo a ${editForm.recipient || 'Destinatario'}`;
    action.description = `Asunto: "${editForm.subject}"`;
    action.payload.omittedAttachments = undefined;
    setEditingActionId(null);
    onChange?.();
  };

  return (
    <div className="pa-list">
      {pendingActions.map(action => {
        const isEditing = editingActionId === action.id;
        const kind = KIND[action.actionType] ?? FALLBACK_KIND;
        const Icon = kind.icon;
        const isSend = action.actionType === 'SEND_EMAIL';
        const needsBody = Boolean(action.payload.body?.includes(MANUAL_BODY_PLACEHOLDER));
        const count = action.payload.emailIds?.length ?? 0;
        const options = action.payload.emailOptions ?? [];
        const pickable = options.length > 1;
        const noneSelected = pickable && count === 0;
        const headline = isSend ? action.payload.recipient || 'Sin destinatario' : (action.payload.emailOptions?.length ?? 0) > 1 ? `${action.payload.emailIds?.length ?? 0} de ${action.payload.emailOptions?.length} correos` : action.title;
        const fieldId = (name: string) => `pa-${action.id}-${name}`;
        const note = needsBody
          ? 'Escribe el mensaje con «Editar» antes de enviarlo.'
          : !action.payload.isReal
            ? 'Modo demostración: no se cambiará ningún correo real.'
            : isSend
              ? `Se enviará desde tu cuenta de ${MAIL} al pulsar Enviar. Después no se puede anular.`
              : kind.tone === 'danger'
                ? PLATFORM === 'outlook' ? 'Irá a Elementos eliminados de Outlook, donde podrás recuperarlo.' : 'Irá a la papelera de Gmail, donde podrás recuperarlo durante 30 días.'
                : action.actionType === 'RESTORE_EMAIL'
                ? `Volverá a tu bandeja de entrada de ${MAIL}.`
                : action.aiExplanation;

        const busy = working === action.id;
        const restoredNote = action.restored
          ? `Recuperada después de recargar. Revisa que siga siendo correcta antes de aprobarla.${action.payload.omittedAttachments?.length ? ` Tenía ${action.payload.omittedAttachments.length === 1 ? 'un adjunto' : action.payload.omittedAttachments.length + ' adjuntos'} (${action.payload.omittedAttachments.join(', ')}) que no se guardan: vuelve a adjuntarlos con «Editar».` : ''}`
          : '';

        return (
          <article key={action.id} className={`pa-card pa-${kind.tone}`} aria-busy={busy} aria-label={`${kind.label}: ${headline}`}>
            <header className="pa-head">
              <span className="pa-icon" aria-hidden="true"><Icon /></span>
              <div className="pa-heading">
                <span className="pa-kind">{kind.label}</span>
                <h3 className="pa-title">{headline}</h3>
              </div>
              <span className={`pa-impact pa-impact-${action.impactScore === 'Crítico' || action.impactScore === 'Alto' ? 'high' : 'low'}`}>
                Impacto {action.impactScore.toLowerCase()}
              </span>
            </header>

            {isEditing ? (
              <div className="pa-form">
                <label htmlFor={fieldId('to')}>Para</label>
                <input
                  id={fieldId('to')}
                  type="email"
                  value={editForm.recipient}
                  onChange={e => setEditForm(prev => ({ ...prev, recipient: e.target.value }))}
                />
                <label htmlFor={fieldId('subject')}>Asunto</label>
                <input
                  id={fieldId('subject')}
                  type="text"
                  value={editForm.subject}
                  onChange={e => setEditForm(prev => ({ ...prev, subject: e.target.value }))}
                />
                <label htmlFor={fieldId('body')}>Mensaje</label>
                <textarea
                  id={fieldId('body')}
                  rows={8}
                  value={editForm.body}
                  onChange={e => setEditForm(prev => ({ ...prev, body: e.target.value }))}
                />
                {editForm.files.length > 0 && (
                  <ul className="pa-files pa-files-edit" aria-label="Adjuntos">
                    {editForm.files.map((file, index) => (
                      <li key={index}>
                        {file.type.startsWith('image/') ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
                        <span>{file.name}</span><small>{file.originalSize ? <span title="Foto reducida para enviarla más rápido">{formatSize(file.originalSize)} → {formatSize(file.size)}</span> : formatSize(file.size)}</small>
                        <button type="button" className="cm-remove" onClick={() => setEditForm(prev => ({ ...prev, files: prev.files.filter((_, i) => i !== index) }))} aria-label={`Quitar ${file.name}`}><X aria-hidden="true" /></button>
                      </li>
                    ))}
                  </ul>
                )}
                {fileError && <p className="cm-error" role="alert">{fileError}</p>}
              </div>
            ) : (
              <>
                <dl className="pa-fields">
                  {isSend && action.payload.subject && (
                    <div><dt>Asunto</dt><dd>{action.payload.subject}</dd></div>
                  )}
                  {!isSend && !pickable && action.description && (
                    <div><dt>{count > 1 ? 'Correos' : 'Correo'}</dt><dd>{action.description}</dd></div>
                  )}
                  {!isSend && count > 1 && !pickable && (
                    <div><dt>Total</dt><dd>{count} correos</dd></div>
                  )}
                  {action.actionType === 'LABEL_EMAIL' && action.payload.label && (
                    <div><dt>Etiqueta</dt><dd>{action.payload.label}</dd></div>
                  )}
                </dl>
                {pickable && (
                  <fieldset className="pa-picks">
                    <legend>
                      <span>{count} de {options.length} correos seleccionados</span>
                      <span className="pa-picks-all">
                        <button type="button" onClick={() => setAllEmails(action, true)} disabled={busy || count === options.length}>Todos</button>
                        <button type="button" onClick={() => setAllEmails(action, false)} disabled={busy || count === 0}>Ninguno</button>
                      </span>
                    </legend>
                    <ul>
                      {options.map((option) => {
                        const checked = action.payload.emailIds?.includes(option.id) ?? false;
                        return (
                          <li key={option.id}>
                            <label className={checked ? '' : 'pa-pick-off'}>
                              <input type="checkbox" checked={checked} disabled={busy} onChange={() => toggleEmail(action, option.id)} />
                              <span className="pa-pick-text"><strong>{option.subject}</strong><small>{option.sender}{option.date ? ` · ${option.date}` : ''}</small></span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                )}
                {isSend && action.payload.body && (
                  <div className="pa-message">{action.payload.body}</div>
                )}
                {isSend && !!action.payload.attachments?.length && (
                  <ul className="pa-files" aria-label="Adjuntos">
                    {action.payload.attachments.map((file, index) => (
                      <li key={index}><Paperclip aria-hidden="true" /><span>{file.name}</span><small>{file.originalSize ? <span title="Foto reducida para enviarla más rápido">{formatSize(file.originalSize)} → {formatSize(file.size)}</span> : formatSize(file.size)}</small></li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {restoredNote && (
              <p className="pa-note pa-note-restored">
                <History aria-hidden="true" />
                <span>{restoredNote}</span>
              </p>
            )}
            <p className="pa-note">
              <Info aria-hidden="true" />
              <span>{note}</span>
            </p>

            <footer className="pa-actions">
              {isEditing ? (
                <>
                  <input ref={fileInput} type="file" multiple hidden onChange={e => void addFiles(e.target.files)} />
                  <button type="button" key="attach" className="pa-btn pa-btn-ghost pa-edit" onClick={() => fileInput.current?.click()} title={`Adjuntar archivos o imágenes (hasta ${MAX_ATTACHMENT_LABEL} en total)`}>
                    <Paperclip aria-hidden="true" />
                    Adjuntar
                  </button>
                  <button type="button" key="cancel" className="pa-btn pa-btn-ghost" onClick={() => setEditingActionId(null)}>
                    Cancelar
                  </button>
                  <button type="button" key="save" className="pa-btn pa-btn-primary" onClick={() => handleSaveEdit(action)}>
                    <Check aria-hidden="true" />
                    Guardar cambios
                  </button>
                </>
              ) : (
                <>
                  {isSend && (
                    <button type="button" key="edit" className="pa-btn pa-btn-ghost pa-edit" disabled={busy} onClick={() => handleStartEdit(action)}>
                      <PenLine aria-hidden="true" />
                      Editar
                    </button>
                  )}
                  <button
                    type="button"
                    key="reject"
                    className="pa-btn pa-btn-secondary"
                    disabled={busy}
                    onClick={() => onReject(action)}
                    title="Descartar esta propuesta sin ejecutarla"
                  >
                    <X aria-hidden="true" />
                    Rechazar
                  </button>
                  <button
                    type="button"
                    key="approve"
                    className={`pa-btn ${kind.tone === 'danger' ? 'pa-btn-danger' : 'pa-btn-primary'}`}
                    onClick={() => void approve(action)}
                    disabled={busy || needsBody || noneSelected}
                    aria-busy={busy}
                    title={needsBody ? 'Edita el borrador y escribe el mensaje antes de aprobar' : noneSelected ? 'Selecciona al menos un correo' : `Aprobar esta propuesta y ejecutarla en ${MAIL}`}
                  >
                    {busy ? <Loader2 aria-hidden="true" className="spin" /> : <Check aria-hidden="true" />}
                    {busy ? kind.working : <>{kind.confirm}{pickable ? ` (${count})` : ''}</>}
                  </button>
                </>
              )}
            </footer>
          </article>
        );
      })}
    </div>
  );
};
