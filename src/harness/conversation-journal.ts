import type { HarnessAttachment, HarnessCommandResult } from './contracts';
import {FSError} from '@itookit/vfs-core';
export interface HarnessRecovery {
    submission?: {id: string; status: 'pending' | 'accepted' | 'rejected'; turnId?: string};
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
        || receipt.turnId !== undefined && (typeof receipt.turnId !== 'string' || !receipt.turnId))
        throw new FSError('EINVAL', 'Invalid submission receipt');
    return {...receipt};
}
