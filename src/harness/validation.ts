import { FSError } from '@itookit/vfs-core';
import type { HarnessAttachment, HarnessEvents, HarnessHistory, HarnessPage, HarnessProfile, HarnessReceipt, HarnessSession } from './contracts';

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
        || (v.archived !== undefined && typeof v.archived !== 'boolean')
        || !(v.activeTurnId === undefined || v.activeTurnId === null || typeof v.activeTurnId === 'string')) throw invalid();
    if (v.statusDetails !== undefined && v.statusDetails !== null) {
        const status = record(v.statusDetails);
        if (typeof status.type !== 'string' || status.activeFlags !== undefined && (!Array.isArray(status.activeFlags)
            || status.activeFlags.some(flag => typeof flag !== 'string'))) throw invalid();
    }
    if (v.lastTurnResult !== undefined && v.lastTurnResult !== null && !['completed', 'failed', 'cancelled'].includes(String(v.lastTurnResult))) throw invalid();
    const native = v.native && typeof v.native === 'object' ? v.native as Record<string, unknown> : {};
    return {...v, title: [v.title, native.name, native.preview].find(text => typeof text === 'string' && text.trim())?.toString().trim() ?? '',
        lastTurnResult: v.lastTurnResult ?? undefined,
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
            || (caps.search !== undefined && typeof caps.search !== 'boolean')
            || ['rename', 'archive', 'unarchive', 'delete'].some(key => caps[key] !== undefined && typeof caps[key] !== 'boolean')
            || caps.attachments !== undefined && (!Array.isArray(caps.attachments) || caps.attachments.length > 2 || caps.attachments.some(kind => !['text', 'image'].includes(String(kind))))
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

/** Validate locally owned drafts before writing or starting a native operation. */
export function validateAttachments(value: unknown): HarnessAttachment[] {
    if (value === undefined) return [];
    const fail = () => new FSError('EINVAL', 'Invalid native attachment draft');
    if (!Array.isArray(value) || value.length > 5) throw fail();
    let total = 0;
    for (const file of value) {
        if (!file || !['text', 'image'].includes(file.kind) || typeof file.content !== 'string' || typeof file.name !== 'string'
            || !file.name || /[\x00-\x1f\x7f/\\]/.test(file.name) || new TextEncoder().encode(file.name).byteLength > 256) throw fail();
        const size = new TextEncoder().encode(file.content).byteLength; total += size;
        if (file.kind === 'text' && (size > 64 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.content))) throw fail();
        if (file.kind === 'image') {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType) || !file.content.startsWith(`data:${file.mimeType};base64,`)) throw fail();
            const encoded = file.content.split(',')[1] ?? '';
            if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) > 256 * 1024) throw fail();
        }
    }
    if (total > 512 * 1024) throw fail();
    return structuredClone(value as HarnessAttachment[]);
}

export function validateDeletedSessionIds(value: unknown, sessionId: string): string[] {
    if (!Array.isArray(value) || !value.includes(sessionId) || value.length > 16401
        || value.some(id => typeof id !== 'string' || !id || id.length > 512) || new Set(value).size !== value.length)
        throw new FSError('EIO', 'Invalid native deletion receipt');
    return value;
}
