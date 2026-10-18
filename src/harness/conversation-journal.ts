import type { HarnessAttachment, HarnessCommandResult } from './contracts';
export interface HarnessRecovery {
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
