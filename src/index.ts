export { createPiAgentDriver } from './provider';
export type { RemoteAuthorization, RemoteProjectCapabilities } from './authorization';
export { validateAuthorization } from './authorization';
export type { PiAgentDriver, PiAgentDescriptor } from './provider';
export * from './files/index';
export type { HarnessClient, HarnessMutationOptions, HarnessProfile, HarnessSession, HarnessPage, HarnessHistory, HarnessHistoryOptions, HarnessEvent, HarnessEvents, HarnessReceipt } from './harness/contracts';

export type { ProjectClient, RemoteProject, ProjectMount, RegisterProject, ProjectProcess } from './projects';

export type { DirectorySyncClient, DirectorySyncBinding, DirectorySyncInput, DirectorySyncPlan, DirectoryContent } from './directory-sync';
export type { DirectorySyncDirection, DirectorySyncConflict, DirectorySyncComparison, SyncContentPreview } from './directory-sync';

export { HarnessConversation } from './harness/conversation';
export type { HarnessMessage, HarnessRequest } from './harness/conversation-model';

export type { HarnessConversationJournal, HarnessRecovery } from './harness/conversation-journal';

export type { HarnessConversationPort, HarnessConversationSnapshot } from './harness/conversation';
export { harnessObservation } from './harness/state';
export type { HarnessObservation, HarnessExecutionState } from './harness/state';
export type { HarnessStatusPort, HarnessStatusRow } from './harness/status-observer';
export type { FileSearchQuery, FileSearchResult, FileSearchMatch } from './search';
export type { HarnessSearchMatch, HarnessSearchResult } from './harness/contracts';
export { conversationBranches } from './harness/branches';
export type { HarnessAttachment, HarnessTurnOptions } from './harness/contracts';

export type { HarnessUsage, HarnessUsageEntry, HarnessTokens } from './harness/usage';
