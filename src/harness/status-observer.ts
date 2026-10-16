import type { HarnessClient, HarnessSession, HarnessProfile, HarnessEvents } from './contracts';
import { nativeRequest } from './conversation-model';
import { applyHarnessStatus, harnessObservation, type HarnessObservation } from './state';

export interface HarnessStatusRow { profileId: string; sessionId: string; observation: HarnessObservation; title?: string; archived?: boolean; fileVersion?: string }
export interface HarnessStatusPort {
    fileVersion?(): string | undefined;
    poll(options?: import('@itookit/vfs-core').OperationOptions): Promise<HarnessStatusRow[]>;
    close(): Promise<void>;
}
interface ProfileState {
    profile: HarnessProfile;
    sessions: Map<string, HarnessSession>;
    observations: Map<string, HarnessObservation>;
    cursor?: {after: number; eventEpoch: string};
    listedAt: number;
    fileVersion?: string;
}

/** One bounded metadata/event stream per project, never reads histories or adopts threads. */
export class HarnessStatusObserver implements HarnessStatusPort {
    private readonly profiles = new Map<string, ProfileState>();
    private directoryVersion?: string;
    fileVersion() { return this.directoryVersion; }
    private pending?: Promise<HarnessStatusRow[]>;
    constructor(private readonly client: HarnessClient, private readonly now = Date.now, private readonly writable = true) {}
    poll(options?: import('@itookit/vfs-core').OperationOptions): Promise<HarnessStatusRow[]> {
        if (this.pending) return this.pending;
        const work = this.update(options).finally(() => { this.pending = undefined; });
        this.pending = work; return work;
    }
    private async update(options?: import('@itookit/vfs-core').OperationOptions): Promise<HarnessStatusRow[]> {
        try {
            this.directoryVersion = await this.client.directoryVersion?.(options);
            if (!this.profiles.size) for (const profile of (await this.client.profiles(options)).profiles) {
                if (profile.projectRuntime && profile.capabilities.history && this.profiles.size < 16) this.profiles.set(profile.id,
                    {profile, sessions: new Map(), observations: new Map(), listedAt: 0});
            }
            for (const state of this.profiles.values()) {
                const page = await this.client.events(state.profile.id, state.cursor, {...options, toolDetail: 'summary'});
                const repair = page.gap || !!state.cursor && state.cursor.eventEpoch !== page.epoch;
                const refresh = repair || this.now() - state.listedAt >= 15_000 || !state.listedAt;
                if (refresh) await this.list(state, options);
                this.consume(state, page, refresh);
                state.cursor = {after: page.cursor, eventEpoch: page.epoch};
            }
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            for (const state of this.profiles.values()) for (const [id, prior] of state.observations)
                state.observations.set(id, {...prior, connection: 'offline', stale: true, canInterrupt: false, canRespond: false});
        }
        return [...this.profiles.values()].flatMap(state => [...state.observations].map(([sessionId, observation]) =>
            ({profileId: state.profile.id, sessionId, observation, title: state.sessions.get(sessionId)?.title, archived: state.sessions.get(sessionId)?.archived, fileVersion: state.fileVersion})));
    }
    private async list(state: ProfileState, options?: import('@itookit/vfs-core').OperationOptions) {
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let count = 0; count < 8; count++) {
            const page = await this.client.list(state.profile.id, {cursor}, options);
            for (const session of page.sessions) {
                if (!state.sessions.has(session.id) && state.sessions.size >= 512) {
                    const oldest = state.sessions.keys().next().value!;
                    state.sessions.delete(oldest); state.observations.delete(oldest);
                }
                const prior = state.sessions.get(session.id);
                const next = {...session, lastTurnResult: session.lastTurnResult ?? prior?.lastTurnResult,
                    activeTurnId: session.activeTurnId ?? (session.status === 'active' ? prior?.activeTurnId : null)};
                state.sessions.set(session.id, next);
                state.observations.set(session.id, harnessObservation(next, [], {source: 'list', observedAt: this.now()}));
            }
            if (!page.nextCursor) break;
            if (seen.has(page.nextCursor)) throw new Error('Harness list cursor did not advance');
            seen.add(page.nextCursor); cursor = page.nextCursor;
        }
        state.listedAt = this.now();
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
            const id = message.params?.threadId;
            if (typeof id !== 'string' || !state.sessions.has(id)) continue;
            if (message.method === 'thread/deleted') { state.sessions.delete(id); state.observations.delete(id); continue; }
            const prior = state.sessions.get(id)!, next = applyHarnessStatus(prior, message);
            if (next !== prior) { state.sessions.set(id, next); changed.add(id); }
        }
        for (const [id, session] of state.sessions) {
            const requests = page.requests.filter(r => r.params?.threadId === id).flatMap(nativeRequest);
            const prior = state.observations.get(id)!;
            const fresh = changed.has(id) || requests.length > 0, observedAt = fresh ? this.now() : prior.observedAt;
            const observation = harnessObservation(session, requests, {observedAt,
                source: fresh ? 'events' : prior.source, stale: this.now() - observedAt > 30_000,
                connection: page.events.some(e => e.message.method === 'harness/disconnected' && (!e.message.params?.threadId || e.message.params.threadId === id)) ? 'offline' : fresh ? 'online' : prior.connection});
            const controlled = (state.profile.projectCapabilities?.sessionControl ?? this.writable) && observation.owned && !observation.stale && observation.connection === 'online';
            observation.canInterrupt = controlled && !!session.activeTurnId && state.profile.capabilities.interrupt;
            observation.canRespond = controlled && !!requests.length && state.profile.capabilities.interactions;
            state.observations.set(id, observation);
        }
    }
    close() { return this.client.close(); }
}
