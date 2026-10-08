import { FSError, type OperationOptions, type RecordValue } from '@itookit/vfs-core';
import { HttpTransport, type HttpConnectionOptions } from '../transport';

export interface HttpSeqSnapshot { revision: string | null; entries: Array<{ key: string; value: RecordValue }> }
export type HttpSeqChange = { action: 'set'; key: string; value: RecordValue } | { action: 'delete'; key: string };

/** A transaction changes one portable SQLite SeqFile, with the existing mutation receipt protocol. */
export class HttpSeqClient {
    private readonly transport: HttpTransport;
    private readonly base: string;
    constructor(options: HttpConnectionOptions & { alias: string }) {
        if (!/^[a-zA-Z0-9_-]+$/.test(options.alias)) throw new FSError('EINVAL', 'Invalid export alias');
        this.base = `v1/fs/${options.alias}`; this.transport = new HttpTransport(options);
    }
    dispose(): void { this.transport.close(); }
    async snapshot(path: string, options?: OperationOptions): Promise<HttpSeqSnapshot> {
        const result = await this.transport.json<HttpSeqSnapshot>(`${this.base}/seq/snapshot`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: this.path(path) }),
        }, options, 32 * 1024 * 1024);
        if (!result || typeof result !== 'object' || !(result.revision === null || typeof result.revision === 'string') || !Array.isArray(result.entries)
            || result.entries.some(entry => !entry || typeof entry.key !== 'string' || !Object.hasOwn(entry, 'value')))
            throw new FSError('EIO', 'Invalid SeqFile snapshot');
        return result;
    }
    async transaction(path: string, expectedRevision: string | null, changes: readonly HttpSeqChange[], options?: OperationOptions): Promise<{ revision: string }> {
        const result = await this.transport.mutate<{ revision: string }>(`${this.base}/seq/transaction`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: this.path(path), expectedRevision, changes }),
        }, `${this.base}/operations`, options);
        if (!result || typeof result.revision !== 'string' || !result.revision)
            throw new FSError('EIO', 'Invalid committed SeqFile transaction result');
        return result;
    }
    private path(path: string): string {
        const relative = path.replace(/^\//, '');
        if (!relative.endsWith('.seq') || relative.includes('\\') || relative.includes('\0')
            || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new FSError('EINVAL', 'Invalid SeqFile path');
        return relative;
    }
}
