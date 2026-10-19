import type { HarnessAttachment, HarnessCommandResult } from './contracts';
import {FSError} from '@itookit/vfs-core';
export interface HarnessRecovery {
    responses?: Array<{id: string | number; requestId: string; epoch: string}>;
    submission?: {id: string; status: 'pending' | 'accepted' | 'rejected'; turnId?: string; code?: string};
    submittedTurnId?: string;
    deletedSessionIds?: string[];
    draft?: string;
    draftAttachments?: HarnessAttachment[];
    draftRevision?: number;
    commandResults?: HarnessCommandResult[];
    sessionId?: string;
    pending?: {requestId: string; epoch: string; operation: string; inputText?: string; draftRevision?: number};
}
export interface HarnessConversationJournal {
    epoch: string;
    load(): Promise<HarnessRecovery | undefined>;
    save(record: HarnessRecovery): Promise<void>;
}
export function validateSubmission(value: unknown): HarnessRecovery['submission'] {
    if (value === undefined) return;
    const receipt = value as NonNullable<HarnessRecovery['submission']>;
    if (!receipt || typeof receipt.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.id)
        || !['pending', 'accepted', 'rejected'].includes(receipt.status)
        || receipt.turnId !== undefined && (typeof receipt.turnId !== 'string' || !receipt.turnId)
        || receipt.code !== undefined && (typeof receipt.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.code)))
        throw new FSError('EINVAL', 'Invalid submission receipt');
    return {...receipt};
}
