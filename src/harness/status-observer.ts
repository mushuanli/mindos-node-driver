import type { HarnessClient, HarnessSession, HarnessProfile, HarnessEvents } from './contracts';
import { nativeRequest } from './conversation-model';
import { applyHarnessStatus, harnessObservation, type HarnessObservation } from './state';
import { ObservationErrors, connectionLost } from './observation-errors';

export interface HarnessStatusRow { profileId: string; sessionId: string; observation: HarnessObservation; title?: string; archived?: boolean; fileVersion?: string; truncated?: boolean }
export interface HarnessStatusPort {
    subscribe(listener: () => void): () => void;
    fileVersion?(): string | undefined;
    refresh(options?: import('@itookit/vfs-core').OperationOptions): Promise<HarnessStatusRow[]>;
    close(): Promise<void>;
}
interface ProfileState {
    profile: HarnessProfile;
    sessions: Map<string, HarnessSession>;
    observations: Map<string, HarnessObservation>;
    cursor?: {after: number; eventEpoch: string};
    listedAt: number;
    fileVersion?: string;
    nativeDisconnected: Set<string>;
    errors: ObservationErrors;
    truncated?: boolean;
    notificationCursor?: {after: number; eventEpoch: string};
    requestSignature?: string;
}

/** One bounded metadata/event stream per project, never reads histories or adopts threads. */
export class HarnessStatusObserver implements HarnessStatusPort {
    private readonly listeners = new Set<() => void>();
    private readonly stops = new Map<string, () => void>();
    private notify = () => { for (const listener of this.listeners) listener(); };
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        if (this.watchFiles && !this.stops.has('directory')) this.stops.set('directory',this.client.subscribeDirectory?.(this.notify) ?? (() => {}));
        for (const state of this.profiles.values()) this.observe(state.profile.id);
        return () => { this.listeners.delete(listener); if (!this.listeners.size) { for (const stop of this.stops.values()) stop(); this.stops.clear(); } };
    }
    private observe(id: string): void {
        if (this.listeners.size && !this.stops.has(id)) {
            const state = this.profiles.get(id)!;
            state.notificationCursor = state.cursor;
            this.stops.set(id,this.client.subscribe(id,() => { void this.changed(state); }));
        }
    }
    private async changed(state: ProfileState): Promise<void> {
        try {
            const page = await this.client.eventSnapshot(state.profile.id,state.notificationCursor);
            state.notificationCursor = {after:page.cursor,eventEpoch:page.epoch};
            const requests = JSON.stringify(page.requests);
            const changedRequests = requests !== (state.requestSignature ?? '[]'); state.requestSignature = requests;
            const relevant = page.events.some(({message}) => /^(thread\/|turn\/|harness\/|serverRequest\/)/.test(message.method)
                || message.method === 'item/completed' && (message.params?.item as {type?: string})?.type === 'fileChange');
            if (page.gap || changedRequests || relevant) this.notify();
        } catch { this.notify(); }
    }
    private readonly profiles = new Map<string, ProfileState>();
    private directoryVersion?: string;
    private readonly errors = new ObservationErrors();
    fileVersion() { return this.directoryVersion; }
    private pending?: Promise<HarnessStatusRow[]>;
    constructor(private readonly client: HarnessClient, private readonly now = Date.now, private readonly writable = true,
        private readonly watchFiles = true) {}
    refresh(options?: import('@itookit/vfs-core').OperationOptions): Promise<HarnessStatusRow[]> {
        if (this.pending) return this.pending;
        const work = this.update(options).finally(() => { this.pending = undefined; });
        this.pending = work; return work;
    }
    private async update(options?: import('@itookit/vfs-core').OperationOptions): Promise<HarnessStatusRow[]> {
        if (this.watchFiles) await this.watchDirectory(options);
        try {
            if (!this.profiles.size) for (const profile of (await this.client.profiles(options)).profiles) {
                if (profile.projectRuntime && profile.capabilities.history && this.profiles.size < 16) this.profiles.set(profile.id,
                    {profile, sessions: new Map(), observations: new Map(), listedAt: 0,
                        nativeDisconnected: new Set(), errors: new ObservationErrors(profile.id)});
            }
            this.errors.clear('profiles');
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            this.errors.record('profiles', error);
        }
        for (const state of this.profiles.values()) await this.updateProfile(state, options);
        for (const state of this.profiles.values()) this.observe(state.profile.id);
        return [...this.profiles.values()].flatMap(state => [...state.observations].map(([sessionId, observation]) =>
            ({profileId: state.profile.id, sessionId, observation, title: state.sessions.get(sessionId)?.title, archived: state.sessions.get(sessionId)?.archived, fileVersion: state.fileVersion,
                ...(state.truncated ? {truncated: true} : {})})));
    }
    private async watchDirectory(options?: import('@itookit/vfs-core').OperationOptions): Promise<void> {
        try {
            this.directoryVersion = await this.client.directorySnapshot?.();
            this.errors.clear('directory');
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            this.errors.record('directory', error);
        }
    }
    private async updateProfile(state: ProfileState, options?: import('@itookit/vfs-core').OperationOptions): Promise<void> {
        let stage = 'events';
        try {
            const page = await this.client.eventSnapshot(state.profile.id, state.cursor, {...options, toolDetail: 'summary'});
            state.errors.clear(stage);
            const repair = page.gap || !!state.cursor && state.cursor.eventEpoch !== page.epoch;
            const refresh = repair || this.now() - state.listedAt >= 15_000 || !state.listedAt;
            if (refresh) { stage = 'list'; await this.list(state, options); state.errors.clear(stage); }
            stage = 'projection';
            this.consume(state, page, refresh);
            state.errors.clear(stage);
            state.cursor = {after: page.cursor, eventEpoch: page.epoch};
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            const refreshError = state.errors.record(stage, error);
            for (const [id, prior] of state.observations) state.observations.set(id, {...prior, refreshError,
                connection: state.nativeDisconnected.has(id) || connectionLost(error) ? 'offline' : 'online',
                stale: true, canInterrupt: false, canRespond: false});
        }
    }
    private async list(state: ProfileState, options?: import('@itookit/vfs-core').OperationOptions) {
        const listed = await this.readList(state.profile.id, options);
        const sessions = listed.complete ? new Map<string, HarnessSession>() : new Map(state.sessions);
        const observations = listed.complete ? new Map<string, HarnessObservation>() : new Map([...state.observations].map(([id, prior]) =>
            [id, {...prior, stale: true, refreshError: {stage: 'list', code: 'LIST_TRUNCATED'}, canInterrupt: false, canRespond: false}]));
        for (const [id, session] of listed.sessions) {
            // A partial enumeration cannot evict known sessions as if they were deleted.
            if (!sessions.has(id) && sessions.size >= 512) continue;
            const prior = state.sessions.get(id);
            const next = {...session, lastTurnResult: session.lastTurnResult ?? prior?.lastTurnResult,
                activeTurnId: session.activeTurnId ?? (session.status === 'active' ? prior?.activeTurnId : null)};
            sessions.set(id, next); state.nativeDisconnected.delete(id);
            observations.set(id, harnessObservation(next, [], {source: 'list', observedAt: this.now()}));
        }
        state.sessions = sessions; state.observations = observations; state.truncated = !listed.complete;
        for (const id of state.nativeDisconnected) if (!sessions.has(id)) state.nativeDisconnected.delete(id);
        state.listedAt = this.now();
    }
    private async readList(profileId: string, options?: import('@itookit/vfs-core').OperationOptions) {
        const seen = new Set<string>(), sessions = new Map<string, HarnessSession>();
        let cursor: string | undefined;
        for (let count = 0; count < 8; count++) {
            const page = await this.client.list(profileId, {cursor}, options);
            for (const session of page.sessions) {
                if (!sessions.has(session.id) && sessions.size >= 512) return {sessions, complete: false};
                sessions.set(session.id, session);
            }
            if (!page.nextCursor) return {sessions, complete: true};
            if (seen.has(page.nextCursor)) throw new Error('Harness list cursor did not advance');
            seen.add(page.nextCursor); cursor = page.nextCursor;
        }
        return {sessions, complete: false};
    }
    private consume(state: ProfileState, page: HarnessEvents, repair: boolean) {
        if (repair && state.cursor) state.fileVersion = `${page.epoch}:${page.cursor}:snapshot`;
        for (const event of page.events) {
            const message = event.message, item = message.params?.item as {type?: string; status?: string} | undefined;
            if (message.method === 'turn/completed' || message.method === 'item/completed' && item?.type === 'fileChange')
                state.fileVersion = `${page.epoch}:${event.seq}`;
        }
        const changed = new Set<string>();
        if (!repair) for (const {message} of page.events) {
            if (message.method === 'harness/disconnected') {
                const id = message.params?.threadId;
                for (const sessionId of state.sessions.keys()) if (!id || sessionId === id) state.nativeDisconnected.add(sessionId);
            }
            const id = message.params?.threadId;
            if (typeof id !== 'string' || !state.sessions.has(id)) continue;
            if (message.method === 'thread/deleted') { state.sessions.delete(id); state.observations.delete(id); state.nativeDisconnected.delete(id); continue; }
            const prior = state.sessions.get(id)!, next = applyHarnessStatus(prior, message);
            if (next !== prior) {
                state.sessions.set(id, next); changed.add(id);
                if (['thread/status/changed', 'turn/started', 'turn/completed'].includes(message.method)) state.nativeDisconnected.delete(id);
            }
        }
        for (const [id, session] of state.sessions) {
            const requests = page.requests.filter(r => r.params?.threadId === id).flatMap(nativeRequest);
            const prior = state.observations.get(id)!;
            const fresh = changed.has(id) || requests.length > 0, observedAt = fresh ? this.now() : prior.observedAt;
            const observation = harnessObservation(session, requests, {observedAt,
                source: fresh ? 'events' : prior.source, stale: this.now() - observedAt > 30_000,
                ...(prior.refreshError?.code === 'LIST_TRUNCATED' && !fresh ? {stale: true, refreshError: prior.refreshError} : {}),
                connection: state.nativeDisconnected.has(id) ? 'offline' : 'online'});
            const controlled = (state.profile.projectCapabilities?.sessionControl ?? this.writable) && observation.owned && !observation.stale && observation.connection === 'online';
            observation.canInterrupt = controlled && !!session.activeTurnId && state.profile.capabilities.interrupt;
            observation.canRespond = controlled && !!requests.length && state.profile.capabilities.interactions;
            state.observations.set(id, observation);
        }
    }
    close() { for (const stop of this.stops.values()) stop(); this.stops.clear(); this.listeners.clear(); return this.client.close(); }
}
