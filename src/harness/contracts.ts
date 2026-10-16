import type { OperationOptions } from '@itookit/vfs-core';
import type { HarnessUsage } from './usage';

export interface HarnessProfile {
    aliases?: string[];
    projectCapabilities?: import('../authorization').RemoteProjectCapabilities;
    id: string; kind: string; projectRuntime?: boolean; workspaces: Array<{ id: string }>;
    capabilities: { usage?: boolean; history: boolean; create: boolean; resume: boolean; interrupt: boolean; interactions: boolean; fork?: boolean; search?: boolean; rename?: boolean; archive?: boolean; unarchive?: boolean; delete?: boolean; attachments?: Array<'text' | 'image'> };
}
export interface HarnessSession {
    usage?: HarnessUsage; usageUnavailable?: boolean;
    id: string; title: string; cwd: string | null; status: string | null; updatedAt: number | null; resumable: boolean;
    createdAt?: number | null;
    owned?: boolean;
    parentSessionId?: string | null;
    branchName?: string | null;
    forkable?: boolean;
    activeTurnId?: string | null;
    statusDetails?: {type: string; activeFlags?: string[]} | null;
    lastTurnResult?: 'completed' | 'failed' | 'cancelled';
    archived?: boolean;
}
export interface HarnessEvent { seq: number; timestamp?: number; message: { method: string; id?: string | number; params?: Record<string, unknown> } }
export interface HarnessEvents {
    epoch: string; cursor: number; gap: boolean; events: HarnessEvent[]; requests: Array<HarnessEvent['message']>;
}
export interface HarnessPage { sessions: HarnessSession[]; nextCursor: string | null }
export interface HarnessHistory { session: HarnessSession; turns: unknown[] | null; nextCursor?: string | null }
export interface HarnessEventsOptions extends OperationOptions { toolDetail?: 'summary' }
export interface HarnessHistoryOptions extends HarnessEventsOptions { cursor?: string }
export interface HarnessReceipt { requestId: string; outcome: 'committed' | 'not-committed' | 'unknown'; result?: unknown; code?: string }
export interface HarnessMutationOptions extends OperationOptions { requestId?: string; epoch?: string }
export interface HarnessAttachment {kind: 'text' | 'image'; name: string; content: string; mimeType?: string}
export interface HarnessTurnOptions extends HarnessMutationOptions {attachments?: HarnessAttachment[]}
export interface HarnessClient {
    usage?(profileId: string, sessionId: string, options?: OperationOptions): Promise<HarnessUsage>;
    directoryVersion?(options?: import('@itookit/vfs-core').OperationOptions): Promise<string | undefined>;
    delete?(profileId: string, sessionId: string, options?: HarnessMutationOptions): Promise<{deletedSessionIds: string[]}>;
    rename?(profileId: string, sessionId: string, name: string, options?: HarnessMutationOptions): Promise<{session: HarnessSession}>;
    archive?(profileId: string, sessionId: string, archived: boolean, options?: HarnessMutationOptions): Promise<{session: HarnessSession}>;
    search?(profileId: string, query: {query: string; mode: 'title' | 'content'; archived?: boolean}, options?: OperationOptions): Promise<HarnessSearchResult>;
    profiles(options?: OperationOptions): Promise<{ epoch: string; profiles: HarnessProfile[] }>;
    list(profileId: string, query?: { cursor?: string; archived?: boolean }, options?: OperationOptions): Promise<HarnessPage>;
    read(profileId: string, sessionId: string, options?: HarnessHistoryOptions): Promise<HarnessHistory>;
    inspect?(profileId: string, sessionId: string, options?: OperationOptions): Promise<{session: HarnessSession}>;
    fork?(profileId: string, sessionId: string, name?: string, options?: HarnessMutationOptions): Promise<{session: HarnessSession}>;
    create(profileId: string, workspaceId: string, options?: HarnessMutationOptions): Promise<{ session: HarnessSession }>;
    resume(profileId: string, sessionId: string, options?: HarnessMutationOptions): Promise<{ session: HarnessSession }>;
    turn(profileId: string, sessionId: string, prompt: string, options?: HarnessTurnOptions): Promise<{ turnId: string }>;
    interrupt(profileId: string, sessionId: string, turnId: string, options?: HarnessMutationOptions): Promise<void>;
    respond(profileId: string, nativeRequestId: string | number, response: Record<string, unknown>, options?: HarnessMutationOptions): Promise<void>;
    events(profileId: string, cursor?: { after: number; eventEpoch: string }, options?: HarnessEventsOptions): Promise<HarnessEvents>;
    operation(profileId: string, requestId: string, options?: HarnessMutationOptions): Promise<HarnessReceipt>;
    close(): Promise<void>;
}
export interface HarnessSearchMatch { sessionId: string; title: string; summary: string; updatedAt: number | null; turnId?: string; itemId?: string }
export interface HarnessSearchResult { matches: HarnessSearchMatch[]; truncated: boolean; nextCursor: null }
