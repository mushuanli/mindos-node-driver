import { FSError } from '@itookit/vfs-core';
import type { HarnessEvents, HarnessHistory, HarnessPage, HarnessProfile, HarnessReceipt, HarnessSession } from './contracts';

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value as Record<string, unknown>;
}
function invalid() { return new FSError('EIO', 'Invalid harness response'); }
function sessionTime(value: unknown): number | null {
    const time = typeof value === 'number' ? value >= 1_000_000_000 && value < 100_000_000_000 ? value * 1000 : value
        : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time > 0 && time <= 8_640_000_000_000_000 ? time : null;
}
export function validateSession(value: unknown): HarnessSession {
    const v = record(value);
    if (typeof v.id !== 'string' || !v.id || typeof v.title !== 'string' || typeof v.resumable !== 'boolean'
        || !(v.cwd === null || typeof v.cwd === 'string') || !(v.status === null || typeof v.status === 'string')
        || !(v.updatedAt === null || (typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt)))
        || !(v.createdAt === undefined || v.createdAt === null || (typeof v.createdAt === 'number' && Number.isFinite(v.createdAt)))
        || !(v.parentSessionId === undefined || v.parentSessionId === null || typeof v.parentSessionId === 'string')
        || !(v.branchName === undefined || v.branchName === null || typeof v.branchName === 'string')
        || (v.forkable !== undefined && typeof v.forkable !== 'boolean')
        || (v.owned !== undefined && typeof v.owned !== 'boolean')
        || !(v.activeTurnId === undefined || v.activeTurnId === null || typeof v.activeTurnId === 'string')) throw invalid();
    const native = v.native && typeof v.native === 'object' ? v.native as Record<string, unknown> : {};
    return {...v, title: [v.title, native.name, native.preview].find(text => typeof text === 'string' && text.trim())?.toString().trim() ?? '',
        createdAt: sessionTime(v.createdAt ?? native.createdAt), updatedAt: sessionTime(v.updatedAt ?? native.updatedAt)} as unknown as HarnessSession;
}
export function validateProfiles(value: unknown): { epoch: string; profiles: HarnessProfile[] } {
    const v = record(value);
    if (typeof v.epoch !== 'string' || !v.epoch || !Array.isArray(v.profiles)) throw invalid();
    for (const profile of v.profiles) {
        const p = record(profile), caps = record(p.capabilities);
        if (typeof p.id !== 'string' || !p.id || typeof p.kind !== 'string' || !p.kind || !Array.isArray(p.workspaces)
            || p.workspaces.some(w => typeof record(w).id !== 'string')
            || (caps.fork !== undefined && typeof caps.fork !== 'boolean')
            || ['history','create','resume','interrupt','interactions'].some(key => typeof caps[key] !== 'boolean')) throw invalid();
    }
    return v as unknown as { epoch: string; profiles: HarnessProfile[] };
}
export function validatePage(value: unknown): HarnessPage {
    const v = record(value);
    if (!Array.isArray(v.sessions) || !(v.nextCursor === null || typeof v.nextCursor === 'string')) throw invalid();
    return {...v, sessions: v.sessions.map(validateSession)} as unknown as HarnessPage;
}
export function validateHistory(value: unknown): HarnessHistory {
    const v = record(value), session = validateSession(v.session);
    if (!(v.turns === null || Array.isArray(v.turns)) || !(v.nextCursor === undefined || v.nextCursor === null || typeof v.nextCursor === 'string')) throw invalid();
    return {...v, session} as unknown as HarnessHistory;
}
export function validateEvents(value: unknown): HarnessEvents {
    const v = record(value);
    if (typeof v.epoch !== 'string' || !v.epoch || !Number.isSafeInteger(v.cursor) || (v.cursor as number) < 0 || typeof v.gap !== 'boolean'
        || !Array.isArray(v.events) || !Array.isArray(v.requests)) throw invalid();
    let previous = 0;
    for (const event of v.events) {
        const e = record(event);
        if (!Number.isSafeInteger(e.seq) || (e.seq as number) <= previous || (e.seq as number) > (v.cursor as number)
            || (e.timestamp !== undefined && (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)))
            || typeof record(e.message).method !== 'string') throw invalid();
        previous = e.seq as number;
    }
    for (const request of v.requests) if (typeof record(request).method !== 'string') throw invalid();
    return v as unknown as HarnessEvents;
}
export function validateReceipt(value: unknown): HarnessReceipt {
    const v = record(value);
    if (typeof v.requestId !== 'string' || !['committed','not-committed','unknown'].includes(String(v.outcome))) throw invalid();
    return v as unknown as HarnessReceipt;
}
