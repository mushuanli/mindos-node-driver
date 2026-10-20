import type {HarnessAttachment, HarnessSlashCommand} from './contracts';
import type {HarnessRecovery} from './conversation-journal';
import type {HarnessMessage} from './conversation-model';
import type {HarnessRequest} from './interactions';
import type {HarnessObservation} from './state';
import type {HarnessUsage} from './usage';

export interface HarnessConversationActions {
    canSend: boolean;
    canInterrupt: boolean;
    canRespond: boolean;
    canFork: boolean;
    canDelete: boolean;
    canRename: boolean;
    canArchive: boolean;
    canUnarchive: boolean;
}
/** Public read model; runtime fields and private implementation never define this contract. */
export interface HarnessConversationSnapshot extends HarnessConversationActions {
    sessionId?: string;
    title: string;
    createdAt?: number | null;
    updatedAt?: number | null;
    branchName?: string;
    forkSupport?: 'none' | 'latest' | 'turn';
    archived: boolean;
    deletedSessionIds: string[];
    messages: HarnessMessage[];
    requests: HarnessRequest[];
    hasEarlier: boolean;
    observation: HarnessObservation;
    submission?: HarnessRecovery['submission'];
    submittedTurnId?: string;
    draft: string;
    draftAttachments: HarnessAttachment[];
    attachments?: Array<'text' | 'image'>;
    supportsModels?: boolean;
    supportsSlashCommands?: boolean;
    slashCommands?: HarnessSlashCommand[];
    usage?: HarnessUsage;
    usageUnavailable?: boolean;
    /** Compatibility projections of observation, never independent state. */
    active: boolean;
    pending: boolean;
    disconnected: boolean;
    gap: boolean;
}
