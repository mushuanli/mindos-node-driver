import { FSError } from '@itookit/vfs-core';

/** Input/cache buckets are disjoint; reasoning is a subset of output. */
export interface HarnessTokens {
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
}
export interface HarnessUsageEntry {
    id: string; turnId: string | null; providerId: string | null; modelId: string | null; tokens: HarnessTokens;
}
export interface HarnessUsage {
    sessionId: string; scope: 'transcript'; source: 'native-history'; revision: string;
    complete: boolean; observedAt: number; totals: HarnessTokens; entries: HarnessUsageEntry[];
}
const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
function object(value: unknown): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value as Record<string, any>;
}
function invalid() { return new FSError('EIO', 'Invalid harness usage'); }
function tokens(value: unknown): HarnessTokens {
    const row = object(value);
    if (FIELDS.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)) throw invalid();
    return Object.fromEntries(FIELDS.map(key => [key, row[key]])) as unknown as HarnessTokens;
}
function entry(value: unknown, ids: Set<string>): HarnessUsageEntry {
    const row = object(value);
    if (typeof row.id !== 'string' || !row.id || row.id.length > 2048 || ids.has(row.id)
        || ['turnId','providerId','modelId'].some(key => row[key] !== null && (typeof row[key] !== 'string' || row[key].length > 512))) throw invalid();
    ids.add(row.id);
    return {id: row.id, turnId: row.turnId, providerId: row.providerId, modelId: row.modelId, tokens: tokens(row.tokens)};
}
export function validateUsage(value: unknown, sessionId?: string): HarnessUsage {
    const row = object(value), totals = tokens(row.totals);
    if (typeof row.sessionId !== 'string' || !row.sessionId || sessionId !== undefined && row.sessionId !== sessionId
        || row.scope !== 'transcript' || row.source !== 'native-history' || typeof row.revision !== 'string' || row.revision.length > 256
        || typeof row.complete !== 'boolean' || !Number.isSafeInteger(row.observedAt) || row.observedAt <= 0
        || !Array.isArray(row.entries) || row.entries.length > 8192) throw invalid();
    const ids = new Set<string>(), entries = row.entries.map((raw: unknown) => entry(raw, ids)) as HarnessUsageEntry[];
    if (FIELDS.some(key => entries.reduce((sum, row) => sum + row.tokens[key], 0) !== totals[key])) throw invalid();
    return {sessionId: row.sessionId, scope: 'transcript', source: 'native-history', revision: row.revision,
        complete: row.complete, observedAt: row.observedAt, totals, entries};
}
