import type { HarnessAttachment } from './contracts';
export interface HarnessRecovery {
    draft?: string;
    draftAttachments?: HarnessAttachment[];
    sessionId?: string;
    pending?: {requestId: string; epoch: string; operation: string};
}
export interface HarnessConversationJournal {
    epoch: string;
    load(): Promise<HarnessRecovery | undefined>;
    save(record: HarnessRecovery): Promise<void>;
}
