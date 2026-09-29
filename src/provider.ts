import { FSError, FileStorageAdapter, createFileSystemSource,
    type FileSystemSourceOwner, type OperationOptions } from '@itookit/vfs-core';
import { HttpFSBackend } from './backend';
import { discoverServer, type RemoteServerCapabilities } from './capabilities';
import { HttpProcessSession, type RemoteProcessSpec } from './process';
import { SourcePool } from './provider/source-pool';
import { readExports } from './protocol/exports';
import { HttpTransport } from './transport';

export interface RemoteConnection { endpoint: string; alias: string; credentialRef: string; username?: string; }
type ServerConnection = Omit<RemoteConnection, 'alias'>;
type CredentialResolver = (reference: string) => string | Promise<string>;

export interface HttpSourceProvider {
    open(connection: RemoteConnection, options?: OperationOptions): Promise<FileSystemSourceOwner>;
    process(connection: ServerConnection, spec: RemoteProcessSpec): Promise<Pick<HttpProcessSession, 'nativeShell' | 'release'>>;
    capabilities(connection: ServerConnection, options?: OperationOptions): Promise<RemoteServerCapabilities>;
    check(connection: ServerConnection, options?: OperationOptions): Promise<void>;
    checkDraft(connection: ServerConnection, password: string, options?: OperationOptions): Promise<void>;
    browse(connection: ServerConnection, path: string, cursor?: string, options?: OperationOptions): Promise<{ paths: string[]; nextCursor: string | null }>;
    setCredential(reference: string, secret: string): () => void;
    clearCredential(reference: string): void;
    dispose(): Promise<void>;
}

export function createHttpSourceProvider(resolveCredential?: CredentialResolver): HttpSourceProvider {
    return new SourceProvider(resolveCredential);
}

/** Host-facing composition; pooling and wire protocol have independent owners. */
class SourceProvider implements HttpSourceProvider {
    private readonly credentials = new Map<string, string>();
    private readonly sources = new SourcePool();
    constructor(private readonly resolveCredential?: CredentialResolver) {}

    private credential(reference: string) {
        return async () => {
            const secret = this.credentials.get(reference) ?? await this.resolveCredential?.(reference);
            if (!secret) throw new FSError('EACCES', 'Remote credentials required', 'credential');
            return secret;
        };
    }

    clearCredential(reference: string) { this.credentials.delete(reference); }
    setCredential(reference: string, secret: string) {
        const previous = this.credentials.get(reference);
        this.credentials.set(reference, secret);
        return () => { if (previous === undefined) this.credentials.delete(reference); else this.credentials.set(reference, previous); };
    }

    async process(connection: ServerConnection, spec: RemoteProcessSpec) {
        const owner = new HttpProcessSession(this.transport(connection), spec);
        return { nativeShell: owner.nativeShell, release: () => owner.release() };
    }

    open(connection: RemoteConnection, options?: OperationOptions): Promise<FileSystemSourceOwner> {
        return this.sources.acquire(connectionKey(connection), async signal => {
            const backend = new HttpFSBackend({ ...connection, credential: this.credential(connection.credentialRef) });
            try {
                await backend.init({ signal });
                return createFileSystemSource({ backend: new FileStorageAdapter(backend), viewId: `http:${connection.credentialRef}`,
                    access: backend.mutations ? 'rw' : 'ro', tags: false });
            } catch (error) { await backend.close(); throw error; }
        }, options);
    }

    async capabilities(connection: ServerConnection, options?: OperationOptions) {
        const transport = this.transport(connection);
        try { return await discoverServer(transport, options); } finally { transport.close(); }
    }

    check(connection: ServerConnection, options?: OperationOptions) { return this.checkDraft(connection, '', options); }
    async checkDraft(connection: ServerConnection, password: string, options?: OperationOptions) {
        const transport = this.transport(connection, password);
        try { await readExports(transport, options); } finally { transport.close(); }
    }

    async browse(connection: ServerConnection, path: string, cursor?: string, options?: OperationOptions) {
        if (path === '/') {
            const transport = this.transport(connection);
            try {
                const exports = await readExports(transport, options);
                return { paths: exports.map(item => `/${item.alias}`), nextCursor: null };
            } finally { transport.close(); }
        }
        if (!/^\/[a-zA-Z0-9_-]+(?:\/[^/]+)*$/.test(path)) throw new FSError('EINVAL', 'Invalid browse path');
        const [, alias, ...segments] = path.split('/');
        const backend = new HttpFSBackend({ ...connection, alias, credential: this.credential(connection.credentialRef) });
        try {
            const page = await backend.files.list(segments.join('/'), { ...options, cursor });
            return { paths: page.entries.filter(item => item.stat.kind === 'directory').map(item => `${path}/${item.name}`), nextCursor: page.nextCursor };
        } finally { await backend.close(); }
    }

    private transport(connection: ServerConnection, password?: string) {
        return new HttpTransport({ ...connection, credential: password ? () => password : this.credential(connection.credentialRef) });
    }

    async dispose() { this.credentials.clear(); await this.sources.dispose(); }
}

/** Credential identity participates in sharing; the secret itself never does. */
function connectionKey(connection: RemoteConnection): string {
    return JSON.stringify([connection.endpoint, connection.alias, connection.credentialRef, connection.username ?? '']);
}
