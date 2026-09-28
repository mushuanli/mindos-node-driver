import { checkOperation, FileStorageAdapter, FSError, createFileSystemSource,
    type FileStorageBackend, type FileReader, type FileMutations, type OperationOptions, type FilePage, type FileListOptions, type FileReadOptions } from '@itookit/vfs-core';
import { HttpTransport, type HttpConnectionOptions } from './transport';
import { StatBatch, validateStat } from './stat-batch';

export interface HttpFileSourceOptions extends HttpConnectionOptions { alias: string; }
export interface RemoteExport { alias: string; access: 'ro' | 'rw'; nameSemantics: string; strongRevision?: boolean; }

export class HttpFSBackend implements FileStorageBackend {
    readonly name = 'http';
    private initialized = false;
    readonly files: FileReader;
    mutations?: FileMutations;
    private readonly http: HttpTransport;
    private readonly base: string;
    constructor(private readonly options: HttpFileSourceOptions) {
        if (!/^[a-zA-Z0-9_-]+$/.test(options.alias)) throw new FSError('EINVAL', 'Invalid export alias');
        this.http = new HttpTransport(options); this.base = `v1/fs/${options.alias}`;
        const batch = new StatBatch(this.http, `${this.base}/stat`);
        this.files = { stat: (path, opts) => batch.get(validPath(path), opts),
            statType: (path, opts) => batch.get(validPath(path), opts),
            list: (path, opts) => this.list(path, opts), read: (path, opts) => this.read(path, opts) };
    }
    async init(options?: OperationOptions): Promise<void> {
        checkOperation(options); if (this.initialized) return;
        const result = await this.http.json<{ version: number; exports: RemoteExport[] }>('v1/exports', {}, options);
        if (result.version !== 1 || !Array.isArray(result.exports)) throw new FSError('ECAPABILITY', 'Unsupported file server protocol');
        if (!result.exports.some(item => item.alias === this.options.alias)) throw new FSError('EACCES', 'Export unavailable');
        if (result.exports.find(item => item.alias === this.options.alias)?.access === 'rw' && result.exports.find(item => item.alias === this.options.alias)?.strongRevision === true) this.mutations = this.createMutations();
        this.initialized = true;
    }
    async close(): Promise<void> { this.http.close(); }
    operationStatus(id: string, options?: OperationOptions) {
        return this.http.json<{ outcome: string; result?: unknown; code?: string }>(`${this.base}/operations/${encodeURIComponent(id)}`, {}, options);
    }
    private createMutations(): FileMutations {
        const command = (action: string, path: string, extra: object, options?: OperationOptions) =>
            this.http.mutate(`${this.base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, path: validPath(path), ...extra }) }, `${this.base}/operations`, options);
        return {
            replace: async (path, data, condition, options) => {
                const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
                headers.set(condition.kind === 'create-only' ? 'If-None-Match' : 'If-Match', condition.kind === 'create-only' ? '*' : condition.revision);
                const result = await this.http.mutate<import('@itookit/vfs-core').FileStat>(`${this.base}/content?${new URLSearchParams({ path: validPath(path) })}`,
                    { method: 'PUT', headers, body: data.slice().buffer }, `${this.base}/operations`, options);
                validateStat(result); return result;
            },
            mkdir: async (path, options) => { await command('mkdir', path, {}, options); return { kind: 'directory' }; },
            rename: async (path, to, options) => { await command('rename', path, { to: validPath(to) }, options); },
            remove: async (path, options) => { await command('remove', path, { recursive: options?.recursive ?? false }, options); },
        };
    }
    private async list(path: string, options?: FileListOptions): Promise<FilePage> {
        const query = new URLSearchParams({ path: validPath(path) });
        if (options?.cursor) query.set('cursor', options.cursor);
        const page = await this.http.json<FilePage>(`${this.base}/entries?${query}`, {}, options);
        if (!Array.isArray(page.entries) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new FSError('EIO', 'Invalid directory response');
        for (const entry of page.entries) { validPath(entry.name); if (!entry.name || entry.name.includes('/')) throw new FSError('EIO', 'Invalid child name'); validateStat(entry.stat); }
        return page;
    }
    private async read(path: string, options?: FileReadOptions) {
        checkOperation(options);
        const offset = options?.offset ?? 0, length = options?.length;
        if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw new FSError('EINVAL', 'Invalid read range');
        validPath(path);
        if (length !== undefined && !Number.isSafeInteger(offset + length)) throw new FSError('EINVAL', 'Read range overflow');
        if (length === 0) return { data: new Uint8Array() };
        const headers = new Headers();
        if (offset || length !== undefined) headers.set('Range', `bytes=${offset}-${length === undefined ? '' : offset + length - 1}`);
        if (options?.ifRevision) headers.set('If-Match', options.ifRevision);
        const result = await this.http.content(`${this.base}/content?${new URLSearchParams({ path: validPath(path) })}`, { headers }, options);
        if (headers.has('Range')) {
            const range = result.range?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
            if (result.status !== 206 || !range || Number(range[1]) !== offset || Number(range[2]) - offset + 1 !== result.data.length)
                throw new FSError('EIO', 'Unexpected range response');
        }
        if (options?.ifRevision && result.revision !== options.ifRevision) throw new FSError('ECONFLICT', 'Read revision changed');
        return { data: result.data, revision: result.revision };
    }
}

export async function openHttpFileSource(options: HttpFileSourceOptions, viewId = `http:${options.alias}`) {
    const backend = new HttpFSBackend(options); await backend.init();
    return createFileSystemSource({ backend: new FileStorageAdapter(backend), viewId, access: backend.mutations ? 'rw' : 'ro', tags: false });
}

function validPath(path: string): string {
    if (typeof path !== 'string' || new TextEncoder().encode(path).length > 4096 || path.startsWith('/') || /[\\\0]/.test(path)
        || path.split('/').some(part => part === '..' || part === '.' || part.includes(':')))
        throw new FSError('EINVAL', 'Expected an export-relative path');
    return path;
}
