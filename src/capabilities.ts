import { FSError, type OperationOptions } from '@itookit/vfs-core';
import { HttpTransport, HttpResponseError } from './transport';

/** Discovery describes support, never a grant to execute in a directory. */
export interface RemoteServerCapabilities {
    version: 1;
    serverId: string | null;
    files: { read: boolean; write: boolean };
    sync: { push: boolean };
    process: { exec: boolean };
    terminal: { pty: boolean };
    executionModel: 'none' | 'trusted-cooperative-host' | 'sandbox';
    workspaceConsistency: 'none' | 'cooperative' | 'isolated';
    readOnlyEnforcement: 'none' | 'best-effort' | 'kernel-enforced';
    pathModel: 'none' | 'host-mapped' | 'virtual-root';
}

export async function discoverServer(transport: HttpTransport, options?: OperationOptions): Promise<RemoteServerCapabilities> {
    try { return parseCapabilities(await transport.json('v1/capabilities', {}, options)); }
    catch (error) {
        if (!(error instanceof HttpResponseError) || error.status !== 404) throw error;
        // Authenticate a legacy endpoint before classifying a missing route as files-only.
        const legacy = await transport.json<{ version: number; exports: unknown[] }>('v1/exports', {}, options);
        if (legacy?.version !== 1 || !Array.isArray(legacy.exports)) throw invalid();
        return { version: 1, serverId: null, files: { read: true, write: legacy.exports.some(item =>
            !!item && typeof item === 'object' && 'access' in item && item.access === 'rw') },
        sync: { push: false }, process: { exec: false }, terminal: { pty: false }, executionModel: 'none',
        workspaceConsistency: 'none', readOnlyEnforcement: 'none', pathModel: 'none' };
    }
}

function parseCapabilities(value: unknown): RemoteServerCapabilities {
    if (!value || typeof value !== 'object') throw invalid();
    const v = value as RemoteServerCapabilities;
    if (v.version !== 1 || !(v.serverId === null || typeof v.serverId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v.serverId))) throw invalid();
    if ([v.files?.read, v.files?.write, v.sync?.push, v.process?.exec, v.terminal?.pty].some(flag => typeof flag !== 'boolean')) throw invalid();
    if (!['none', 'trusted-cooperative-host', 'sandbox'].includes(v.executionModel)
        || !['none', 'cooperative', 'isolated'].includes(v.workspaceConsistency)
        || !['none', 'best-effort', 'kernel-enforced'].includes(v.readOnlyEnforcement)
        || !['none', 'host-mapped', 'virtual-root'].includes(v.pathModel)) throw invalid();
    if (v.process.exec && (!v.serverId || v.executionModel === 'none' || v.workspaceConsistency === 'none' || v.pathModel === 'none')) throw invalid();
    if (v.terminal.pty && !v.process.exec) throw invalid();
    return structuredClone(v);
}
function invalid() { return new FSError('EIO', 'Invalid server capabilities', 'protocol'); }
