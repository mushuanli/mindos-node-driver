import { requestId as createRequestId } from '../files/request-id';
import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessClient, HarnessMutationOptions, HarnessEvents, HarnessHistory, HarnessPage, HarnessReceipt, HarnessSession, HarnessHistoryOptions, HarnessEventsOptions } from './contracts';
import { HarnessRpc } from './rpc';
import { validateUsage } from './usage';
import {validateModels, validateModelSelection} from './models';
import {validateCommands, validateCommandResult} from './commands';
import { validateDeletedSessionIds, validateEvents, validateHistory, validatePage, validateProfiles, validateReceipt, validateSession } from './validation';

/** Native task ownership lives on the gateway; this client never replays a mutation. */
export class MCPHarnessClient implements HarnessClient {
    async models(profileId: string, sessionId?: string, options?: OperationOptions) {
        return validateModels(await this.rpc.call('harness_models', {...this.scope, profileId, ...(sessionId ? {sessionId} : {})}, options));
    }
    async commands(profileId: string, sessionId?: string, options?: OperationOptions) {
        return validateCommands(await this.rpc.call('harness_commands', {...this.scope, profileId, ...(sessionId ? {sessionId} : {})}, options));
    }
    async command(profileId: string, sessionId: string, command: string, args: string, options?: import('./contracts').HarnessCommandOptions) {
        return await this.mutate('harness_command', {profileId, sessionId, command, arguments: args, ...(options?.selection ? {selection: validateModelSelection(options.selection)} : {})}, options, validateCommandResult) as import('./contracts').HarnessCommandResult;
    }
    private epoch?: string;
    private watchId?: string;
    private filesEnabled?: boolean;
    constructor(private readonly rpc: HarnessRpc, private readonly scope: {projectId: string; revision: number; readOnly?: boolean; capabilities?: import('../authorization').RemoteProjectCapabilities} | undefined = undefined) {}
    async directoryVersion(options?: OperationOptions): Promise<string | undefined> {
        if (!this.scope) return;
        if (this.filesEnabled === undefined) {
            const meta = await this.rpc.metadata?.(options);
            const capability = (meta?.['itookit/pi-agent'] ?? meta?.['itookit/fs-agent']) as {fileWatch?: boolean} | undefined;
            this.filesEnabled = capability?.fileWatch === true;
        }
        if (!this.filesEnabled) return;
        const result = await this.rpc.call('project_watch', {...this.scope, ...(this.watchId ? {watchId: this.watchId} : {})}, options) as {watchId?: unknown; version?: unknown; gap?: unknown; truncated?: unknown};
        if (typeof result?.watchId !== 'string' || !/^[a-f0-9]{32}$/.test(result.watchId) || typeof result.version !== 'string' || result.version.length > 128 || !result.version.startsWith(result.watchId + ':') || typeof result.gap !== 'boolean' || typeof result.truncated !== 'boolean') throw new FSError('EIO', 'Invalid directory watch response');
        this.watchId = result.watchId;
        return result.version;
    }
    async search(profileId: string, query: {query: string; mode: 'title' | 'content' | 'prompt'; archived?: boolean}, options?: OperationOptions) {
        const keywords = /[^\S\r\n]/u.test(query.query);
        if (keywords || query.mode === 'prompt') {
            const capabilities = (await this.profiles(options)).profiles.find(profile => profile.id === profileId || profile.aliases?.includes(profileId))?.capabilities;
            if (query.mode === 'prompt' && !capabilities?.searchPrompts) throw new FSError('ECAPABILITY', 'Prompt search requires a newer server');
            if (keywords && !capabilities?.searchKeywords) throw new FSError('ECAPABILITY', 'Keyword search requires a newer server');
        }
        const result = await this.rpc.call('harness_session_search', {...this.scope, profileId, ...query}, options) as import('./contracts').HarnessSearchResult;
        if (!result || !Array.isArray(result.matches) || result.matches.length > 100 || typeof result.truncated !== 'boolean' || result.nextCursor !== null)
            throw new FSError('EIO', 'Invalid harness search response');
        for (const row of result.matches) if (!row || typeof row.sessionId !== 'string' || !row.sessionId || typeof row.title !== 'string'
            || typeof row.summary !== 'string' || row.summary.length > 2000 || !(row.updatedAt === null || typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt))
            || row.itemId !== undefined && row.itemId !== null && typeof row.itemId !== 'string'
            || row.turnId !== undefined && row.turnId !== null && typeof row.turnId !== 'string') throw new FSError('EIO', 'Invalid harness search match');
        return {...result, matches: result.matches.map(row => ({...row, turnId: row.turnId ?? undefined, itemId: row.itemId ?? undefined}))};
    }
    async profiles(options?: OperationOptions) {
        const value = validateProfiles(await this.rpc.call('harness_profiles', {}, options));
        this.epoch = value.epoch;
        if (this.scope) value.profiles=value.profiles.filter(profile => profile.projectRuntime).map(profile => ({...profile,projectCapabilities:this.scope!.capabilities,workspaces:[{id:this.scope!.projectId}]}));
        if (this.scope?.capabilities?.sessionControl === false) value.profiles=value.profiles.map(profile => ({...profile, capabilities:{...profile.capabilities,create:false,resume:false,interrupt:false,interactions:false,fork:false,rename:false,archive:false,unarchive:false,delete:false}}));
        return value;
    }
    async list(profileId: string, query = {}, options?: OperationOptions): Promise<HarnessPage> {
        return validatePage(await this.rpc.call('harness_sessions', { ...this.scope, profileId, ...query }, options));
    }
    async usage(profileId: string, sessionId: string, options?: OperationOptions) {
        return validateUsage(await this.rpc.call('harness_session_usage', {...this.scope, profileId, sessionId}, options), sessionId);
    }
    async read(profileId: string, sessionId: string, options?: HarnessHistoryOptions): Promise<HarnessHistory> {
        return validateHistory(await this.rpc.call('harness_session_read', { ...this.scope, profileId, sessionId, ...(options?.cursor ? {cursor:options.cursor} : {}), ...(options?.toolDetail ? {toolDetail: options.toolDetail} : {}) }, options));
    }
    async inspect(profileId: string, sessionId: string, options?: OperationOptions) {
        try {
            const value = await this.rpc.call('harness_session_info', {...this.scope, profileId, sessionId}, options);
            return {session:validateSession((value as {session?:unknown})?.session)};
        } catch (error) {
            if ((error as {remoteCode?:string})?.remoteCode !== 'ECAPABILITY') throw error;
            return {session:(await this.read(profileId,sessionId,options)).session};
        }
    }
    fork(profileId: string, sessionId: string, name?: string, options?: HarnessMutationOptions) {
        return this.session('harness_fork', {profileId, sessionId, ...(name ? {name} : {})}, options);
    }
    async delete(profileId: string, sessionId: string, options?: HarnessMutationOptions): Promise<{deletedSessionIds: string[]}> {
        return await this.mutate('harness_delete', {profileId, sessionId}, options, value => {
            return {deletedSessionIds: validateDeletedSessionIds((value as {deletedSessionIds?: unknown})?.deletedSessionIds, sessionId)};
        }) as {deletedSessionIds: string[]};
    }
    rename(profileId: string, sessionId: string, name: string, options?: HarnessMutationOptions) {
        return this.session('harness_rename', {profileId, sessionId, name}, options);
    }
    archive(profileId: string, sessionId: string, archived: boolean, options?: HarnessMutationOptions) {
        return this.session(archived ? 'harness_archive' : 'harness_unarchive', {profileId, sessionId}, options);
    }
    create(profileId: string, workspaceId: string, options?: OperationOptions) { return this.session('harness_create', { profileId, workspaceId }, options); }
    resume(profileId: string, sessionId: string, options?: OperationOptions) { return this.session('harness_resume', { ...this.scope, profileId, sessionId }, options); }
    private async session(name: string, args: object, options?: HarnessMutationOptions): Promise<{ session: HarnessSession }> {
        return await this.mutate(name, args, options, value => {
            const result = value as { session?: unknown };
            return { session: validateSession(result?.session) };
        }) as { session: HarnessSession };
    }
    async turn(profileId: string, sessionId: string, prompt: string, options?: import('./contracts').HarnessTurnOptions) {
        return await this.mutate('harness_turn', { profileId, sessionId, prompt, ...(options?.selection ? {selection: validateModelSelection(options.selection)} : {}), ...(options?.attachments?.length ? {attachments: options.attachments} : {}) }, options, value => {
            const result = value as { turnId?: unknown };
            if (typeof result?.turnId !== 'string' || !result.turnId) throw new FSError('EIO', 'Invalid harness turn');
            return { turnId: result.turnId };
        }) as { turnId: string };
    }
    async interrupt(profileId: string, sessionId: string, turnId: string, options?: OperationOptions) {
        await this.mutate('harness_interrupt', { profileId, sessionId, turnId }, options);
    }
    async respond(profileId: string, nativeRequestId: string | number, response: Record<string, unknown>, options?: OperationOptions) {
        await this.mutate('harness_respond', { profileId, nativeRequestId, response }, options);
    }
    async events(profileId: string, cursor = {}, options?: HarnessEventsOptions): Promise<HarnessEvents> {
        return validateEvents(await this.rpc.call('harness_events', { ...this.scope, profileId, ...cursor, ...(options?.toolDetail ? {toolDetail: options.toolDetail} : {}) }, options));
    }
    async operation(profileId: string, requestId: string, options?: OperationOptions): Promise<HarnessReceipt> {
        if (!this.epoch) await this.profiles(options);
        const receipt = validateReceipt(await this.rpc.call('harness_operation', { ...this.scope, profileId, requestId, epoch: (options as HarnessMutationOptions)?.epoch ?? this.epoch }, options));
        if (receipt.requestId !== requestId) throw new FSError('EIO', 'Mismatched harness receipt');
        return receipt;
    }
    private async mutate(name: string, args: object, options?: HarnessMutationOptions, decode = (value: unknown): unknown => value): Promise<unknown> {
        if (!this.epoch) await this.profiles(options);
        const requestId = options?.requestId ?? createRequestId();
        try {
            const receipt = validateReceipt(await this.rpc.call(name, { ...args, ...this.scope, epoch: options?.epoch ?? this.epoch, requestId }, options));
            if (receipt.requestId !== requestId) throw new FSError('EIO', 'Mismatched harness receipt');
            if (receipt.outcome !== 'committed') throw Object.assign(new FSError('EIO', receipt.code ?? 'Harness operation incomplete'), receipt);
            return decode(receipt.result);
        } catch (error) {
            if (error && typeof error === 'object' && 'outcome' in error) throw error;
            throw Object.assign(new FSError('EIO', 'Harness operation outcome unknown'), { requestId, outcome: 'unknown', cause: error });
        }
    }
    async close() {
        try { if (this.watchId && this.scope) await this.rpc.call('project_unwatch', {...this.scope, watchId: this.watchId}, {timeoutMs: 2000}); }
        catch { /* The server expires disconnected observers. */ }
        finally { this.watchId = undefined; await this.rpc.close(); }
    }
}
