import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessClient, HarnessMutationOptions, HarnessEvents, HarnessHistory, HarnessPage, HarnessReceipt, HarnessSession, HarnessHistoryOptions, HarnessEventsOptions } from './contracts';
import { HarnessRpc } from './rpc';
import { validateEvents, validateHistory, validatePage, validateProfiles, validateReceipt, validateSession } from './validation';

/** Native task ownership lives on the gateway; this client never replays a mutation. */
export class MCPHarnessClient implements HarnessClient {
    private epoch?: string;
    constructor(private readonly rpc: HarnessRpc, private readonly scope: {projectId: string; revision: number; readOnly?: boolean} | undefined = undefined) {}
    async profiles(options?: OperationOptions) {
        const value = validateProfiles(await this.rpc.call('harness_profiles', {}, options));
        this.epoch = value.epoch;
        if (this.scope) value.profiles=value.profiles.filter(profile => profile.projectRuntime).map(profile => ({...profile,workspaces:[{id:this.scope!.projectId}]}));
        return value;
    }
    async list(profileId: string, query = {}, options?: OperationOptions): Promise<HarnessPage> {
        return validatePage(await this.rpc.call('harness_sessions', { ...this.scope, profileId, ...query }, options));
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
    create(profileId: string, workspaceId: string, options?: OperationOptions) { return this.session('harness_create', { profileId, workspaceId }, options); }
    resume(profileId: string, sessionId: string, options?: OperationOptions) { return this.session('harness_resume', { ...this.scope, profileId, sessionId }, options); }
    private async session(name: string, args: object, options?: HarnessMutationOptions): Promise<{ session: HarnessSession }> {
        return await this.mutate(name, args, options, value => {
            const result = value as { session?: unknown };
            return { session: validateSession(result?.session) };
        }) as { session: HarnessSession };
    }
    async turn(profileId: string, sessionId: string, prompt: string, options?: OperationOptions) {
        return await this.mutate('harness_turn', { profileId, sessionId, prompt }, options, value => {
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
        const requestId = options?.requestId ?? globalThis.crypto.randomUUID();
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
    close() { return this.rpc.close(); }
}
