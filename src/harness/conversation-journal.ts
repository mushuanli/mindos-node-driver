export interface HarnessRecovery {
    draft?: string;
    sessionId?: string;
    pending?: {requestId: string; epoch: string; operation: string};
}
export interface HarnessConversationJournal {
    epoch: string;
    load(): Promise<HarnessRecovery | undefined>;
    save(record: HarnessRecovery): Promise<void>;
}
