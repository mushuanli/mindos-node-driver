import { assertSync, decimal, sha256, SyncError, validId, type Command, type FileRemote, type Head, type Receipt, type CatalogPage, type ChangePage } from '@itookit/vfs-sync';
import { HttpTransport, type HttpConnectionOptions } from '../files/index';

export interface SyncCapabilities {
    protocolVersion: 1; authorityId: string; namespaceId: string; historyEpoch: string;
    filesManifest: boolean; opaqueBundle: boolean; atomicPublish: boolean; durableOperations: boolean;
    changeFeed: boolean; readPins: boolean; historyList: boolean; projectCheckpoint: boolean;
    limits: Record<string, number>; healthy: boolean;
}
export class HttpSyncClient implements FileRemote {
    private readonly transport: HttpTransport;
    constructor(options: HttpConnectionOptions | HttpTransport, readonly historyEpoch: string) {
        this.transport = options instanceof HttpTransport ? options : new HttpTransport(options);
    }
    close(): void { this.transport.close(); }
    async capabilities(): Promise<SyncCapabilities> {
        const c = await this.transport.json<SyncCapabilities>('v1/sync/capabilities');
        assertSync(c.protocolVersion === 1 && typeof c.authorityId === 'string' && typeof c.namespaceId === 'string'
            && typeof c.historyEpoch === 'string' && c.limits && c.atomicPublish && c.durableOperations, 'INVALID_SYNC_CAPABILITIES');
        return c;
    }
    async json<T>(route: string, body?: unknown): Promise<T> {
        const reply = await this.transport.jsonReply(`v1/sync/${route}`, { headers: this.headers(),
            ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        if (!reply.ok) throw protocolError(reply.value, reply.status);
        return reply.value as T;
    }
    async execute(command: Command): Promise<Receipt> {
        assertSync(command.body.historyEpoch === this.historyEpoch, 'HISTORY_EPOCH_CHANGED');
        const reply = await this.transport.jsonReply(`v1/sync/${command.target}`, {
            method: 'POST', headers: this.headers(), body: JSON.stringify(command.body) });
        const value = reply.value as Receipt;
        if (value?.operation && ['committed', 'not-committed', 'unknown'].includes(value.outcome)) return value;
        throw protocolError(reply.value, reply.status);
    }
    operation(replica: string, seq: string): Promise<Receipt> {
        validId(replica); decimal(seq); return this.json(`replicas/${replica}/operations/${seq}`);
    }
    cancel(command: Command): Promise<Receipt> {
        return this.json(`replicas/${segment(command.body.replicaId)}/operations/${command.body.opSeq}/cancel`,
            { target: command.target, command: command.body });
    }
    replica(replica: string): Promise<{ state: string; lastAdmittedSeq: string }> { return this.json(`replicas/${segment(replica)}`); }
    register(replica: string): Promise<{ state: string; lastAdmittedSeq: string }> { return this.json('replicas', { replicaId: replica }); }
    activate(replica: string, scopes: { projectId: string; cursor: string }[]): Promise<unknown> {
        return this.json(`replicas/${segment(replica)}/activate`, { scopes });
    }
    async head(project: string, dataset: string): Promise<Head> {
        const head = await this.json<Head & { state: string }>(`projects/${segment(project)}/datasets/${segment(dataset)}/head`);
        assertSync(head.state === 'active', 'DATASET_DELETED');
        decimal(head.generation); assertSync(validHash(head.manifestHash));
        return { generation: head.generation, manifestHash: head.manifestHash };
    }
    projects(): Promise<{ projects: { projectId: string; lifecycleRevision: string; state: string }[] }> {
        return this.json('projects?state=all');
    }
    async project(project: string): Promise<{ lifecycleRevision: string; state: string }> {
        const listing = await this.projects();
        const found = listing.projects.find(p => p.projectId === project); assertSync(found, 'PROJECT_NOT_FOUND'); return found;
    }
    async pin(project: string, manifestHash: string, requestKey: string): Promise<string> {
        const pin = await this.json<{ pinId: string }>(`projects/${segment(project)}/read-pins`, { manifestHash, requestKey });
        return pin.pinId;
    }
    async releasePin(project: string, pin: string): Promise<void> {
        await this.json(`projects/${segment(project)}/read-pins/${segment(pin)}/release`, {});
    }
    catalog(project: string, cursor?: string): Promise<CatalogPage> {
        return this.json(`projects/${segment(project)}/datasets?state=all${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    }
    changes(project: string, cursor: string): Promise<ChangePage> {
        return this.json(`projects/${segment(project)}/changes?cursor=${encodeURIComponent(cursor)}`);
    }
    async ack(project: string, replica: string, cursor: string, scopeRevision: string): Promise<void> {
        await this.json(`projects/${segment(project)}/replicas/${segment(replica)}/ack`, { cursor, scopeRevision });
    }
    async check(project: string, hashes: string[]): Promise<{ ready: string[] }> {
        assertSync(hashes.length <= 1000 && hashes.every(validHash));
        return this.json(`projects/${segment(project)}/objects/check`, { hashes });
    }
    async upload(project: string, bytes: Uint8Array): Promise<string> {
        const hash = await sha256(bytes);
        await this.transport.json(`v1/sync/projects/${segment(project)}/objects/${hash}`, { method: 'PUT',
            headers: { ...this.headers(), 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes).buffer });
        return hash;
    }
    async download(project: string, hash: string): Promise<Uint8Array<ArrayBuffer>> {
        assertSync(validHash(hash));
        const reply = await this.transport.content(`v1/sync/projects/${segment(project)}/objects/${hash}`, { headers: this.headers() });
        const bytes = new Uint8Array(reply.data);
        assertSync(await sha256(bytes) === hash, 'OBJECT_HASH_MISMATCH'); return bytes;
    }
    private headers(): Record<string, string> { return { 'X-Sync-History-Epoch': this.historyEpoch }; }
}
function segment(value: string): string { validId(value); return value; }
function validHash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function protocolError(value: unknown, status: number): SyncError {
    const v = value as { code?: unknown; outcome?: unknown } | null;
    if (!v || typeof v.code !== 'string') return new SyncError('INVALID_SYNC_RESPONSE', 'unknown', status);
    return new SyncError(v.code, v.outcome === 'not-committed' ? 'not-committed' : 'unknown', status);
}
