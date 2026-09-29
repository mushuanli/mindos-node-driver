import { discoverServer } from './capabilities';
import { checkOperation, FSError, FileStorageAdapter, createFileSystemSource,
    type FileSystemSourceOwner, type OperationOptions } from '@itookit/vfs-core';
import { HttpFSBackend } from './backend';
import { HttpTransport } from './transport';

interface RemoteConnection { endpoint: string; alias: string; credentialRef: string; username?: string; }
interface SharedSource { source: Promise<FileSystemSourceOwner>; refs: number; }

/** Runtime credential cache populated by the host configuration store or an external resolver. */
export function createHttpSourceProvider(resolveCredential?: (reference: string) => string | Promise<string>) {
    const credentials = new Map<string, string>();
    const sources = new Map<string, SharedSource>();
    const credential = (reference: string) => async () => {
        const secret = credentials.get(reference) ?? await resolveCredential?.(reference);
        if (!secret) throw new FSError('EACCES', 'Remote credentials required', 'credential');
        return secret;
    };
    // One source per endpoint + identity + alias: several projects mounting the same export share
    // the handshake and the connection, and the last owner to release closes it.
    const keyOf = (connection: RemoteConnection) =>
        [connection.endpoint, connection.alias, connection.credentialRef, connection.username ?? ''].join('\u0000');
    const release = async (key: string, entry: SharedSource, source: FileSystemSourceOwner): Promise<void> => {
        entry.refs -= 1;
        if (entry.refs > 0) return;
        if (sources.get(key) === entry) sources.delete(key);
        await source.dispose();
    };
    const openShared = (connection: RemoteConnection, options?: OperationOptions): SharedSource => {
        const key = keyOf(connection);
        const existing = sources.get(key);
        if (existing) return existing;
        const entry: SharedSource = { refs: 0, source: (async () => {
            const backend = new HttpFSBackend({ ...connection, credential: credential(connection.credentialRef) });
            await backend.init(options);
            return createFileSystemSource({ backend: new FileStorageAdapter(backend), viewId: `http:${connection.credentialRef}`,
                access: backend.mutations ? 'rw' : 'ro', tags: false });
        })() };
        sources.set(key, entry);
        void entry.source.catch(() => { if (sources.get(key) === entry) sources.delete(key); });
        return entry;
    };
    return {
        clearCredential(reference: string) { credentials.delete(reference); },
        setCredential(reference: string, secret: string) {
            const previous = credentials.get(reference); credentials.set(reference, secret);
            return () => { if (previous === undefined) credentials.delete(reference); else credentials.set(reference, previous); };
        },
        async open(connection: RemoteConnection, options?: OperationOptions): Promise<FileSystemSourceOwner> {
            checkOperation(options);
            const key = keyOf(connection), entry = openShared(connection, options);
            entry.refs += 1;
            let source: FileSystemSourceOwner;
            try { source = await entry.source; checkOperation(options); }
            catch (error) { await release(key, entry, await entry.source.catch(() => ({ dispose: async () => {} }) as FileSystemSourceOwner)); throw error; }
            let released = false;
            return { fs: source.fs, dispose: async () => { if (released) return; released = true; await release(key, entry, source); } };
        },
        async capabilities(connection: Omit<RemoteConnection, 'alias'>, options?: OperationOptions) {
            const transport = new HttpTransport({ ...connection, credential: credential(connection.credentialRef) });
            try { return await discoverServer(transport, options); } finally { transport.close(); }
        },
        async check(connection: Omit<RemoteConnection, 'alias'>, options?: OperationOptions) {
            const transport = new HttpTransport({ ...connection, credential: credential(connection.credentialRef) });
            try {
                const result = await transport.json<{ version: number; exports: unknown[] }>('v1/exports', {}, options);
                if (result.version !== 1 || !Array.isArray(result.exports)) throw new FSError('EIO', 'Invalid file server response', 'protocol');
            } finally { transport.close(); }
        },
        async checkDraft(connection: Omit<RemoteConnection, 'alias'>, password: string, options?: OperationOptions) {
            const transport = new HttpTransport({ ...connection, credential: password ? async () => password : credential(connection.credentialRef) });
            try {
                const result = await transport.json<{ version: number; exports: unknown[] }>('v1/exports', {}, options);
                if (result.version !== 1 || !Array.isArray(result.exports)) throw new FSError('EIO', 'Invalid file server response', 'protocol');
            } finally { transport.close(); }
        },
        async browse(connection: Omit<RemoteConnection, 'alias'>, path: string, cursor?: string, options?: OperationOptions) {
            if (path === '/') {
                const transport = new HttpTransport({ ...connection, credential: credential(connection.credentialRef) });
                try {
                    const result = await transport.json<{ version: number; exports: { alias: string }[] }>('v1/exports', {}, options);
                    if (result.version !== 1 || !Array.isArray(result.exports)
                        || result.exports.some(item => !item || typeof item.alias !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.alias)))
                        throw new FSError('EIO', 'Invalid file server response', 'protocol');
                    return { paths: result.exports.map(item => `/${item.alias}`), nextCursor: null };
                } finally { transport.close(); }
            }
            const [, alias, ...segments] = path.split('/');
            const backend = new HttpFSBackend({ ...connection, alias, credential: credential(connection.credentialRef) });
            try {
                const page = await backend.files.list(segments.join('/'), { ...options, cursor });
                return { paths: page.entries.filter(item => item.stat.kind === 'directory').map(item => `${path}/${item.name}`), nextCursor: page.nextCursor };
            } finally { await backend.close(); }
        },
        async dispose() {
            credentials.clear();
            const open = [...sources.values()]; sources.clear();
            await Promise.all(open.map(async entry => {
                entry.refs = 0;
                await (await entry.source.catch(() => undefined))?.dispose();
            }));
        },
    };
}
