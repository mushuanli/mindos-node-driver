import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessRpc } from './harness/rpc';
export interface DirectoryContent { kind: 'file' | 'directory'; hash: string | null; executable: boolean; identity: string | null }
export type DirectorySyncDirection = 'both' | 'upload' | 'download';
export interface SyncContentPreview {
    kind: 'missing' | 'file' | 'directory'; hash?: string | null; size?: number; executable?: boolean;
    content?: { text?: string; reason?: 'binary' | 'too-large' | 'unavailable' };
}
export interface DirectorySyncConflict {
    path: string; code: string; baseline: DirectoryContent | null; dataset: DirectoryContent | null;
    directory: DirectoryContent | null; resolvable: boolean;
}
export interface DirectorySyncComparison { path: string; baseline: SyncContentPreview; dataset: SyncContentPreview; directory: SyncContentPreview }
export interface DirectorySyncPlan {
    id: string; manifestHash: string; generation: string; state: 'ready' | 'applying' | 'complete' | 'rejected';
    direction?: DirectorySyncDirection; conflictDetails?: DirectorySyncConflict[];
    actions: Array<{path: string; before: DirectoryContent | null; after: DirectoryContent; side?: 'upload' | 'download'}>;
    conflicts: string[]; accepted: Record<string,DirectoryContent>;
}
export interface DirectorySyncBinding {
    id: string; projectId: string; revision: number; syncProjectId: string; datasetId: string;
    historyEpoch: string; target: string; baseline: Record<string,DirectoryContent>; plan: DirectorySyncPlan | null;
    direction?: DirectorySyncDirection; policyRevision?: number;
}
export interface DirectorySyncInput {
    bindingId: string; projectId: string; revision: number; syncProjectId: string; datasetId: string; historyEpoch: string; target: string;
    direction?: DirectorySyncDirection;
}
export interface DirectorySyncClient {
    directories(projectId: string, revision: number, path: string, options?: OperationOptions): Promise<string[]>;
    bind(input: DirectorySyncInput, options?: OperationOptions): Promise<DirectorySyncBinding>;
    status(bindingId: string, options?: OperationOptions): Promise<DirectorySyncBinding>;
    preview(bindingId: string, options?: OperationOptions): Promise<DirectorySyncPlan>;
    execute(bindingId: string, planId: string, options?: OperationOptions): Promise<DirectorySyncPlan>;
    unbind(bindingId: string, options?: OperationOptions): Promise<void>;
    configure(bindingId: string, policyRevision: number, direction: DirectorySyncDirection, options?: OperationOptions): Promise<DirectorySyncBinding>;
    resolve(bindingId: string, planId: string, decisions: Record<string, 'dataset' | 'directory'>, options?: OperationOptions): Promise<DirectorySyncPlan>;
    compare(bindingId: string, planId: string, path: string, options?: OperationOptions): Promise<DirectorySyncComparison>;
}
/** Plans are durable receipt identities; unknown outcomes require status, never a new plan. */
export class MCPDirectorySyncClient implements DirectorySyncClient {
    constructor(private readonly rpc: HarnessRpc) {}
    async directories(projectId: string, revision: number, path: string, options?: OperationOptions): Promise<string[]> {
        const value=await this.call('project_sync_directories',{projectId,revision,path},options) as {paths?: string[]};
        if (!Array.isArray(value?.paths) || value.paths.some(p=>typeof p!=='string' || p.startsWith('/') || p.split('/').some(s=>!s || s==='.' || s==='..'))) throw invalid();
        return value.paths;
    }
    bind(input: DirectorySyncInput, options?: OperationOptions) { return this.binding('project_sync_bind',input,options); }
    status(bindingId: string, options?: OperationOptions) { return this.binding('project_sync_status',{bindingId},options); }
    preview(bindingId: string, options?: OperationOptions) { return this.plan('project_sync_preview',{bindingId},options); }
    execute(bindingId: string, planId: string, options?: OperationOptions) { return this.plan('project_sync_execute',{bindingId,planId},options); }
    configure(bindingId: string, policyRevision: number, direction: DirectorySyncDirection, options?: OperationOptions) {
        return this.binding('project_sync_configure',{bindingId,policyRevision,direction},options);
    }
    resolve(bindingId: string, planId: string, decisions: Record<string, 'dataset' | 'directory'>, options?: OperationOptions) {
        return this.plan('project_sync_resolve',{bindingId,planId,decisions},options);
    }
    async compare(bindingId: string, planId: string, path: string, options?: OperationOptions): Promise<DirectorySyncComparison> {
        const value=await this.call('project_sync_compare',{bindingId,planId,path},options) as DirectorySyncComparison;
        if (!value || value.path!==path || ![value.baseline,value.dataset,value.directory].every(validPreview)) throw invalid();
        return value;
    }
    async unbind(bindingId: string, options?: OperationOptions) {
        const value=await this.call('project_sync_unbind',{bindingId},options) as {removed?: string};
        if (value?.removed!==bindingId) throw invalid();
    }
    private async call(name: string,args: object,options?: OperationOptions): Promise<unknown> {
        try {return await this.rpc.call(name,args,options);}
        catch(error) {
            const remote=error as {remoteCode?: string; code?: string; outcome?: string; message?: string};
            throw Object.assign(new Error(remote.message ?? 'Directory synchronization failed'),
                {code:remote.remoteCode ?? remote.code ?? 'EIO',outcome:remote.outcome ?? 'unknown'});
        }
    }
    private async binding(name: string,args: object,options?: OperationOptions): Promise<DirectorySyncBinding> {
        const value=await this.call(name,args,options) as {binding?: DirectorySyncBinding}; const b=value?.binding;
        if (!b || typeof b.id!=='string' || typeof b.projectId!=='string' || !Number.isSafeInteger(b.revision) || b.revision<1
            || typeof b.syncProjectId!=='string' || typeof b.datasetId!=='string' || typeof b.historyEpoch!=='string' || typeof b.target!=='string'
            || !b.baseline || typeof b.baseline!=='object') throw invalid();
        if ((b.direction!==undefined && !validDirection(b.direction)) || (b.policyRevision!==undefined && (!Number.isSafeInteger(b.policyRevision) || b.policyRevision<0))) throw invalid();
        if (b.plan!==null) validatePlan(b.plan); return b;
    }
    private async plan(name: string,args: object,options?: OperationOptions): Promise<DirectorySyncPlan> {
        const value=await this.call(name,args,options) as {plan?: DirectorySyncPlan};return validatePlan(value?.plan);
    }
}
function validatePlan(value: unknown): DirectorySyncPlan {
    const p=value as DirectorySyncPlan | undefined;
    if (!p || typeof p.id!=='string' || typeof p.manifestHash!=='string' || typeof p.generation!=='string'
        || !['ready','applying','complete','rejected'].includes(p.state) || !Array.isArray(p.actions) || !Array.isArray(p.conflicts)
        || p.conflicts.some(c=>typeof c!=='string') || p.actions.some(a=>!a || typeof a.path!=='string' || !validContent(a.after)
            || (a.before!==null && !validContent(a.before)) || (a.side!==undefined && !['upload','download'].includes(a.side))) || !p.accepted || typeof p.accepted!=='object'
        || (p.direction!==undefined && !validDirection(p.direction)) || (p.conflictDetails!==undefined && (!Array.isArray(p.conflictDetails) || p.conflictDetails.some(c=>!validConflict(c))))) throw invalid();
    return p;
}
function validContent(value: DirectoryContent): boolean {return !!value && ['file','directory'].includes(value.kind)
    && typeof value.executable==='boolean' && (value.hash===null || typeof value.hash==='string') && (value.identity===null || typeof value.identity==='string');}
function invalid() {return Object.assign(new FSError('EIO','Invalid directory synchronization response'),{outcome:'unknown'});}
function validDirection(value: unknown): boolean { return ['both','upload','download'].includes(value as string); }
function validConflict(c: DirectorySyncConflict): boolean {
    return !!c && typeof c.path==='string' && typeof c.code==='string' && typeof c.resolvable==='boolean'
        && [c.baseline,c.dataset,c.directory].every(v=>v===null || validContent(v));
}
function validPreview(p: SyncContentPreview): boolean {
    return !!p && ['missing','file','directory'].includes(p.kind) && (p.size===undefined || (Number.isSafeInteger(p.size) && p.size>=0))
        && (!p.content || (typeof p.content==='object' && (p.content.text===undefined || (typeof p.content.text==='string' && new TextEncoder().encode(p.content.text).length<=256*1024))
            && (p.content.reason===undefined || ['binary','too-large','unavailable'].includes(p.content.reason))));
}
