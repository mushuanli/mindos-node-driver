import { FSError } from '@itookit/vfs-core';

export interface RemoteAuthorization { principalId: string; anonymous: boolean; revision: string }
export interface RemoteProjectCapabilities {
    fileRead: boolean; fileWrite: boolean; run: boolean; sessionRead: boolean; sessionControl: boolean;
}
export function validateAuthorization(value: unknown): RemoteAuthorization | undefined {
    if (value === undefined) return;
    const v = value as RemoteAuthorization;
    if (!v || typeof v.principalId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.principalId)
        || typeof v.anonymous !== 'boolean' || v.anonymous !== (v.principalId === 'anonymous')
        || typeof v.revision !== 'string' || !/^[a-f0-9]{64}$/.test(v.revision))
        throw new FSError('EIO', 'Invalid remote authorization');
    return {principalId: v.principalId, anonymous: v.anonymous, revision: v.revision};
}
export function validateProjectCapabilities(value: unknown): RemoteProjectCapabilities | undefined {
    if (value === undefined) return;
    const v = value as RemoteProjectCapabilities;
    if (!v || ['fileRead','fileWrite','run','sessionRead','sessionControl'].some(key => typeof v[key as keyof typeof v] !== 'boolean')
        || v.sessionControl && (!v.sessionRead || !v.run) || v.fileWrite && !v.fileRead)
        throw new FSError('EIO', 'Invalid remote project capabilities');
    return structuredClone(v);
}
