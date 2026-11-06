import type { StoredProposal } from '@shared/storage/workspace-storage';
import type { PendingAction } from '../types/email';

/** A proposal older than this is not brought back: the mailbox has probably changed. */
export const PROPOSAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const isoOrNow = (value: string) => (Number.isNaN(Date.parse(value)) ? new Date().toISOString() : new Date(value).toISOString());

/** What is saved: the proposal as shown, without attachment contents (only their names). */
export function toStoredProposals(actions: PendingAction[]): StoredProposal[] {
  return actions.filter((action) => action.status === 'PENDING').slice(0, 50).map((action) => {
    const { attachments, ...payload } = action.payload;
    const omitted = [...(payload.omittedAttachments ?? []), ...(attachments ?? []).map((file) => file.name)];
    const proposal = { ...action, payload: { ...payload, ...(omitted.length ? { omittedAttachments: omitted } : {}) } };
    return { id: action.id, action_type: action.actionType, proposal: proposal as unknown as Record<string, unknown>, created_at: isoOrNow(action.createdAt) };
  });
}

/**
 * Brings back only proposals made for this same account and mode, and recent enough.
 * They come back marked as restored so the person reviews them again before approving.
 */
export function fromStoredProposals(list: StoredProposal[], sessionKey: string, isReal: boolean, now = Date.now()): PendingAction[] {
  return list.flatMap((item) => {
    const action = item.proposal as unknown as PendingAction | undefined;
    if (!action || action.id !== item.id || action.status !== 'PENDING' || !action.payload) return [];
    if (action.payload.sessionKey !== sessionKey || action.payload.isReal !== isReal) return [];
    const created = Date.parse(item.created_at);
    if (Number.isNaN(created) || now - created > PROPOSAL_MAX_AGE_MS) return [];
    return [{ ...action, restored: true, payload: { ...action.payload, attachments: undefined } }];
  });
}
