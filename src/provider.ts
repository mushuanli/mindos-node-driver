import { validateAuthorization, type RemoteAuthorization } from './authorization';
import { createHttpSourceProvider, type HttpSourceProvider, type RemoteConnection } from './files/index';
import { FSError, createFileSystemSource, FileStorageAdapter, type FileSystemSourceOwner } from '@itookit/vfs-core';
import { HttpFSBackend } from './files/index';
import { HttpSyncClient } from './sync/client';
import { MCPHarnessClient } from './harness/client';
import { createHarnessRpc, type HarnessRpc } from './harness/rpc';
import { MCPProjectClient, type ProjectClient, type RemoteProject } from './projects';
import { createProjectProcess } from './project-process';
import type { HarnessClient, HarnessProfile } from './harness/contracts';
import type { HarnessConversationJournal } from './harness/conversation-journal';
import { HarnessConversation, type HarnessConversationPort } from './harness/conversation';
import { HarnessStatusObserver, type HarnessStatusPort } from './harness/status-observer';

type Connection = Omit<RemoteConnection, 'alias'>;
export interface PiAgentDescriptor { authorization?: RemoteAuthorization; version: 1; httpEndpoint: string; serverId: string | null; fileProtocol: 'fs-agent-http-v1'; harness: boolean; projects?: boolean; sync?: boolean; projectProtocol?: string; directorySync?: boolean; directorySyncVersion?: number; fileSearch?: boolean; fileWatch?: boolean; }
export interface PiAgentDriver extends HttpSourceProvider {
    observeHarness(client: HarnessClient, writable?: boolean): HarnessStatusPort;
    open(connection: RemoteConnection & {serverProjectId?: string; serverProjectRevision?: number; access?: 'ro' | 'rw'}, options?: import('@itookit/vfs-core').OperationOptions): ReturnType<HttpSourceProvider['open']>;
    resolveCredential(reference: string): Promise<string>;
    discover(connection: Connection, options?: import('@itookit/vfs-core').OperationOptions): Promise<PiAgentDescriptor>;
    conversation(client: HarnessClient, profile: HarnessProfile, workspaceId: string, sessionId?: string, writable?: boolean, journal?: HarnessConversationJournal): HarnessConversationPort;
    harness(connection: Connection): HarnessClient;
    projects(connection: Connection): ProjectClient;
    projectProcess(connection: Connection, project: RemoteProject, spec: Parameters<HttpSourceProvider['process']>[1]): ReturnType<HttpSourceProvider['process']>;
    sync(connection: Connection, historyEpoch: string): HttpSyncClient;
}

/** A single credential owner; file, sync and harness clients retain independent lifetimes. */
export function createPiAgentDriver(resolveCredential?: (reference: string) => string | Promise<string>, fetch = globalThis.fetch): PiAgentDriver {
    const secrets = new Map<string, string>();
    const credential = async (ref: string) => {
        const value = secrets.get(ref) ?? await resolveCredential?.(ref);
        if (!value) throw new FSError('EACCES', 'Remote credentials required'); return value;
    };
    const files = createHttpSourceProvider(credential, fetch);
    const openFiles = files.open.bind(files);
    const disposeFiles = files.dispose.bind(files);
    const clients = new Set<{close(): Promise<void>}>();
    const processes = new Set<{release(): Promise<void>}>();
    const projectFiles = new Set<FileSystemSourceOwner>();
    return Object.assign(files, {
        resolveCredential: credential,
        observeHarness: (client: HarnessClient, writable = true) => new HarnessStatusObserver(client, Date.now, writable),
        conversation: (client: HarnessClient, profile: HarnessProfile, workspaceId: string, sessionId?: string, writable?: boolean, journal?: HarnessConversationJournal) => new HarnessConversation(client, profile, workspaceId, sessionId, writable, journal),
        async discover(connection: Connection, options?: import('@itookit/vfs-core').OperationOptions): Promise<PiAgentDescriptor> {
            const rpc = createHarnessRpc(connection.endpoint, authenticatedFetch(connection, credential, fetch), true);
            try {
                const value = await discoverCapabilities(rpc,options);
                if (value?.version !== 1 || value.fileProtocol !== 'fs-agent-http-v1' || typeof value.harness !== 'boolean' || typeof value.httpEndpoint !== 'string'
                    || !(value.serverId === null || typeof value.serverId === 'string')) throw new FSError('ECAPABILITY', 'Invalid pi-agent discovery');
                const mcp = new URL(connection.endpoint), http = new URL(value.httpEndpoint, mcp);
                if (http.origin !== mcp.origin || http.username || http.password || http.search || http.hash) throw new FSError('EACCES', 'Invalid pi-agent HTTP endpoint');
                const authorization = validateAuthorization(value.authorization);
                if (authorization && authorization.anonymous !== !!connection.anonymous)
                    throw new FSError('EACCES', 'Remote authentication mode changed');
                return { ...value, authorization, httpEndpoint: http.href.replace(/\/+$/, '') };
            } finally { await rpc.close(); }
        },
        setCredential(ref: string, value: string) {
            const previous = secrets.get(ref); secrets.set(ref, value);
            return () => { if (previous === undefined) secrets.delete(ref); else secrets.set(ref, previous); };
        },
        clearCredential(ref: string) { secrets.delete(ref); },
        harness(connection: Connection) {
            const snapshot = { ...connection };
            const client = new MCPHarnessClient(createHarnessRpc(snapshot.endpoint, authenticatedFetch(snapshot, credential, fetch)));
            const close = client.close.bind(client);
            client.close = async () => { clients.delete(client); await close(); };
            clients.add(client); return client;
        },
        async open(connection: RemoteConnection & {serverProjectId?: string; serverProjectRevision?: number; access?: 'ro' | 'rw'}, options?: import('@itookit/vfs-core').OperationOptions) {
            if (!connection.serverProjectId) return openFiles(connection,options);
            const scopedFetch: typeof globalThis.fetch = (input,init) => {
                const headers=new Headers(init?.headers); headers.set('x-fsagent-project',connection.serverProjectId!);
                headers.set('x-fsagent-project-revision',String(connection.serverProjectRevision));
                headers.set('x-fsagent-project-readonly',String(connection.access==='ro'));
                return fetch(input,{...init,headers});
            };
            const backend=new HttpFSBackend({...connection,credential:() => credential(connection.credentialRef),fetch:scopedFetch});
            try {
                await backend.init(options);
                const owner=await createFileSystemSource({backend:new FileStorageAdapter(backend),viewId:`project:${connection.serverProjectId}:${connection.alias}`,access:connection.access ?? 'ro',tags:false});
                const dispose=owner.dispose.bind(owner);
                owner.dispose=async () => {await dispose();projectFiles.delete(owner);};
                projectFiles.add(owner);return owner;
            }
            catch(error) {await backend.close();throw error;}
        },
        async projectProcess(connection: Connection, project: RemoteProject, spec: Parameters<HttpSourceProvider['process']>[1]) {
            const projects = new MCPProjectClient(createHarnessRpc(connection.endpoint,authenticatedFetch(connection,credential,fetch)));
            try {
                const owner=createProjectProcess({...connection,credential:() => credential(connection.credentialRef),fetch},projects,project,spec);
                const release=owner.release.bind(owner);
                owner.release=async () => {await release(); processes.delete(owner);};
                processes.add(owner); return owner;
            }
            catch(error) {await projects.close(); throw error;}
        },
        projects(connection: Connection) {
            const client = new MCPProjectClient(createHarnessRpc(connection.endpoint,authenticatedFetch(connection,credential,fetch)));
            const close = client.close.bind(client);
            client.close = async () => { clients.delete(client); await close(); };
            clients.add(client); return client;
        },
        sync(connection: Connection, historyEpoch: string) { return new HttpSyncClient(files.transport(connection), historyEpoch); },
        async dispose() {
            const results = await Promise.allSettled([...processes].map(p => p.release()));
            results.push(...await Promise.allSettled([...clients].map(c => c.close())));
            results.push(...await Promise.allSettled([...projectFiles].map(owner => owner.dispose())));
            results.push(...await Promise.allSettled([disposeFiles()]));
            const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
            if (errors.length) throw new AggregateError(errors, 'pi-agent resources failed to close');
            secrets.clear();
        },
    });
}
async function discoverCapabilities(rpc: HarnessRpc,options?: import('@itookit/vfs-core').OperationOptions): Promise<PiAgentDescriptor> {
    const metadata = await rpc.metadata?.(options);
    if (Object.hasOwn(metadata ?? {},'itookit/pi-agent')) return metadata!['itookit/pi-agent'] as PiAgentDescriptor;
    try { return await rpc.call('piagent_capabilities',{},options) as PiAgentDescriptor; }
    catch (error) {
        const failure=error as {remoteCode?: string; code?: string | number};
        if (failure.remoteCode!=='ECAPABILITY' && failure.code!==-32601) throw error;
        return await rpc.call('fsagent_capabilities',{},options) as PiAgentDescriptor;
    }
}

function authenticatedFetch(connection: Connection, credential: (ref: string) => Promise<string>, fetch: typeof globalThis.fetch): typeof globalThis.fetch {
    const endpoint = new URL(connection.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new FSError('EINVAL', 'Invalid agent endpoint');
    return async (input, init) => {
        const headers = new Headers(init?.headers);
        if (connection.authorization) { headers.set('x-pi-agent-principal',connection.authorization.principalId); headers.set('x-pi-agent-grant-revision',connection.authorization.revision); }
        if (connection.anonymous) { headers.delete('Authorization'); return boundedResponse(await fetch(input, {...init, headers, redirect:'error', credentials:'omit', cache:'no-store'})); }
        const secret = await credential(connection.credentialRef);
        const bytes = new TextEncoder().encode(`${connection.username}:${secret}`);
        if (connection.username !== undefined && (!connection.username || /[:\r\n]/.test(connection.username))) throw new FSError('EINVAL', 'Invalid username');
        headers.set('Authorization', connection.username === undefined ? `Bearer ${secret}` : `Basic ${btoa(Array.from(bytes,b => String.fromCharCode(b)).join(''))}`);
        const response = await fetch(input, { ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store' });
        return boundedResponse(response);
    };
}

function boundedResponse(response: Response): Response {
    if (!response.body) return response;
    let bytes = 0;
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk,controller) {
            bytes += chunk.byteLength;
            if (bytes > 32 * 1024 * 1024) throw new FSError('EFBIG', 'Harness response exceeds the read limit');
            controller.enqueue(chunk);
        },
    }));
    return new Response(stream,{ status:response.status,statusText:response.statusText,headers:response.headers });
}
