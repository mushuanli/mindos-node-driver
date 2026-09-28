import { checkOperation, FSError, FileStorageAdapter, createFileSystemSource, type OperationOptions } from '@itookit/vfs-core';
import { HttpFSBackend } from './backend';
import { HttpTransport } from './transport';

/** Runtime-scoped credentials; hosts may resolve persistent references from a secret store. */
export function createHttpSourceProvider(resolveCredential?: (reference: string) => string | Promise<string>) {
    const credentials = new Map<string, string>();
    const credential = (reference: string) => async () => {
        const secret = credentials.get(reference) ?? await resolveCredential?.(reference);
        if (!secret) throw new FSError('EACCES', 'Remote credentials required');
        return secret;
    };
    return {
        setCredential(reference: string, secret: string) {
            const previous = credentials.get(reference); credentials.set(reference, secret);
            return () => { if (previous === undefined) credentials.delete(reference); else credentials.set(reference, previous); };
        },
        async open(connection: { endpoint: string; alias: string; credentialRef: string; username?: string }, options?: OperationOptions) {
            checkOperation(options);
            const backend = new HttpFSBackend({ ...connection, credential: credential(connection.credentialRef) });
            await backend.init(options);
            checkOperation(options);
            return createFileSystemSource({ backend: new FileStorageAdapter(backend), viewId: `http:${connection.credentialRef}`, access: backend.mutations ? 'rw' : 'ro', tags: false });
        },
        async check(connection: { endpoint: string; credentialRef: string; username?: string }, options?: OperationOptions) {
            const transport = new HttpTransport({ ...connection, credential: credential(connection.credentialRef) });
            try {
                const result = await transport.json<{ version: number; exports: unknown[] }>('v1/exports', {}, options);
                if (result.version !== 1 || !Array.isArray(result.exports)) throw new FSError('EIO', 'Invalid file server response');
            } finally { transport.close(); }
        },
        async dispose() { credentials.clear(); },
    };
}
