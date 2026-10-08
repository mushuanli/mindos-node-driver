import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessClient, HarnessProfile, HarnessSession, HarnessEvents } from './contracts';
import { conversationBranches } from './branches';
import { validateSession } from './validation';
import type { HarnessConversationJournal } from './conversation-journal';
import { mergeMessages, historyMessages, nativeMessage, nativeRequest, type HarnessMessage, type HarnessRequest } from './conversation-model';

/** One native conversation; closing a viewer never interrupts its remote turn. */
export class HarnessConversation implements HarnessConversationPort {
    private session?: HarnessSession;
    private messages: HarnessMessage[] = [];
    private requests: HarnessRequest[] = [];
    private cursor?: {after: number; eventEpoch: string};
    private readonly completed = new Set<string>();
    private readonly completedItems = new Set<string>();
    private pending?: {requestId: string; epoch: string; operation: string};
    private loaded = false;
    private earlier?: string;
    private expandedHistory = false;
    private readonly historyCursors = new Set<string>();
    private navigationSessionId?: string;
    private draft = '';
    private writes: Promise<void> = Promise.resolve();
    private disconnected = false;
    private gap = false;
    private busy = false;
    private closing?: Promise<void>;
    private readonly lifetime = new AbortController();
    constructor(private readonly client: HarnessClient, private readonly profile: HarnessProfile,
        private readonly workspaceId: string, sessionId?: string, private readonly writable = true, private readonly journal?: HarnessConversationJournal) {
        if (sessionId) this.session = {id: sessionId, title: sessionId, cwd: null, status: null, updatedAt: null, resumable: false};
    }
    get kind() { return this.profile.kind; }
    private options(): OperationOptions { return {signal: this.lifetime.signal, timeoutMs: 30_000}; }
    snapshot() {
        const active = !!this.session?.activeTurnId || this.session?.status === 'active';
        return {draft: this.draft, sessionId: this.navigationSessionId ?? this.session?.id, title: this.session?.title.trim() || this.profile.kind,
            createdAt: this.session?.createdAt, updatedAt: this.session?.updatedAt,
            branchName: this.session?.branchName ?? (this.session?.parentSessionId ? undefined : 'main'),
            messages: this.messages.map(m => ({...m})), requests: this.requests.map(r => ({...r})),
            hasEarlier: !!this.earlier,
            canFork: !this.lifetime.signal.aborted && this.loaded && this.writable && !this.busy && !active && !this.pending && !this.disconnected && !this.navigationSessionId && !!this.session && this.messages.some(message => message.role === 'user' || message.role === 'assistant') && !!this.client.fork && !!this.profile.capabilities.fork && this.session.forkable !== false,
            canSend: !this.navigationSessionId && this.loaded && !this.lifetime.signal.aborted && this.writable && !this.busy && !active && !this.pending && !this.disconnected && (this.session ? this.session.resumable && (this.session.owned || this.profile.capabilities.resume) : this.profile.capabilities.create),
            canInterrupt: !this.lifetime.signal.aborted && this.writable && !this.busy && !this.pending && !!this.session?.owned && !!this.session.activeTurnId && this.profile.capabilities.interrupt,
            canRespond: !this.lifetime.signal.aborted && this.writable && !this.busy && !this.pending && !!this.session?.owned && this.profile.capabilities.interactions,
            active, pending: !!this.pending, disconnected: this.disconnected, gap: this.gap};
    }
    private async restore() {
        if (this.loaded) return;
        const record = await this.journal?.load();
        if (record?.sessionId && !this.session) this.session = {id: record.sessionId, title: record.sessionId, cwd: null, status: null, updatedAt: null, resumable: false};
        this.pending = record?.pending; this.draft = record?.draft ?? ''; this.loaded = true;
    }
    private save(sessionId = this.session?.id): Promise<void> {
        const record = {sessionId, pending: this.pending, draft: this.draft};
        const write = this.writes.then(() => this.journal?.save(record));
        this.writes = write.catch(() => {}); return write;
    }
    async saveDraft(text: string) {
        await this.restore();
        if (text.length > 1024 * 1024) throw new FSError('EFBIG', 'Remote input draft too large');
        this.draft = text; await this.save();
    }
    private async native<T>(operation: string, call: (options: import('./contracts').HarnessMutationOptions) => Promise<T>): Promise<T> {
        const epoch = this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
        this.pending = {requestId: globalThis.crypto.randomUUID(), epoch, operation};
        try {
            try { await this.save(); } catch (error) { this.pending = undefined; throw error; }
            const result = await call({...this.options(), ...this.pending});
            const session = (result as {session?: HarnessSession} | undefined)?.session;
            const pending = this.pending; this.pending = undefined;
            try { await this.save(session?.id ?? this.session?.id); } catch (error) { this.pending = pending; throw error; }
            return result;
        } catch (error) {
            if ((error as {outcome?: string})?.outcome === 'not-committed') { this.pending = undefined; await this.save(); }
            throw error;
        }
    }
    async read() {
        await this.restore();
        if (this.session) {
            const history = await this.client.read(this.profile.id, this.session.id, {...this.options(), toolDetail: 'summary'});
            const messages = historyMessages(history);
            this.messages = this.expandedHistory ? mergeMessages(this.messages, messages) : messages;
            this.session = history.session;
            if (!this.expandedHistory) { this.earlier = history.nextCursor ?? undefined; this.historyCursors.clear(); }
            for (const message of this.messages) if (message.status === 'completed') this.completedItems.add(message.id);
            while (this.completedItems.size > 1000) this.completedItems.delete(this.completedItems.values().next().value!);
        }
        return this.snapshot();
    }
    async loadEarlier() {
        if (!this.session || !this.earlier || this.busy) throw new FSError('EBUSY','No earlier history available');
        const history = await this.client.read(this.profile.id, this.session.id, {...this.options(), cursor:this.earlier, toolDetail: 'summary'});
        if (history.nextCursor === this.earlier || history.nextCursor && this.historyCursors.has(history.nextCursor)) throw new FSError('EIO','History cursor did not advance');
        this.messages = mergeMessages(historyMessages(history), this.messages); this.expandedHistory = true;
        this.historyCursors.add(this.earlier);
        this.earlier = history.nextCursor ?? undefined;
        return this.snapshot();
    }
    branches() {
        if (!this.session) return Promise.resolve([]);
        return conversationBranches(this.client, this.profile.id, this.session, this.options());
    }
    async fork(name?: string) {
        if (!this.snapshot().canFork || !this.client.fork) throw new FSError('ECAPABILITY','Conversation cannot fork');
        if (name && name.length > 256) throw new FSError('EINVAL','Branch name too long');
        return this.mutate(async () => {
            const result = await this.native('fork', options => this.client.fork!(this.profile.id, this.session!.id, name, options));
            this.navigationSessionId = result.session.id;
        });
    }
    async poll() {
        try {
            const page = await this.client.events(this.profile.id, this.cursor, {...this.options(), toolDetail: 'summary'});
            this.disconnected = false;
            const repair = page.gap || !!this.cursor && this.cursor.eventEpoch !== page.epoch;
            if (repair) { this.gap = true; await this.read(); }
            this.consume(repair ? {...page, events: []} : page);
            if (!repair && page.events.some(e => e.message.method === 'turn/completed' && e.message.params?.threadId === this.session?.id)) await this.read();
            this.cursor = {after: page.cursor, eventEpoch: page.epoch};
        } catch (error) { if (this.lifetime.signal.aborted) throw error; this.disconnected = true; }
        return this.snapshot();
    }
    private consume(page: HarnessEvents) {
        for (const {message, timestamp} of page.events) {
            if (message.method === 'harness/disconnected') this.disconnected = true;
            if (!this.session || message.params?.threadId !== this.session.id) continue;
            this.consumeEvent(message.method, message.params, timestamp);
        }
        this.requests = page.requests.filter(r => this.session && r.params?.threadId === this.session.id).flatMap(nativeRequest);
    }
    private consumeEvent(method: string, params: Record<string, unknown>, at?: number) {
        const turn = params.turn as {id?: string} | undefined;
        const turnId = typeof params.turnId === 'string' ? params.turnId : this.session?.activeTurnId ?? undefined;
        if (method === 'turn/started' && turn?.id && !this.completed.has(turn.id)) { this.session!.activeTurnId = turn.id; this.session!.status = 'active'; }
        if (method === 'turn/completed' && turn?.id) {
            this.completed.add(turn.id);
            if (this.completed.size > 1024) this.completed.delete(this.completed.values().next().value!);
            if (!this.session!.activeTurnId || this.session!.activeTurnId === turn.id) { this.session!.activeTurnId = null; this.session!.status = 'idle'; }
        }
        if (method === 'item/started' || method === 'item/completed') {
            const message = nativeMessage(params.item, `item:${String(params.itemId ?? '')}`, turnId, at);
            if (message) { this.replace(message); if (method === 'item/completed') { this.completedItems.add(message.id); if (this.completedItems.size > 1000) this.completedItems.delete(this.completedItems.values().next().value!); } }
        }
        if (['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'].includes(method)
            && typeof params.delta === 'string' && typeof params.itemId === 'string' && !this.completedItems.has(params.itemId)) {
            if (method === 'item/commandExecution/outputDelta') return;
            const prior = this.messages.find(m => m.id === params.itemId);
            this.replace({...prior, id: params.itemId, turnId: turnId ?? prior?.turnId, timestamp: prior?.timestamp ?? at, role: method.includes('reasoning') ? 'system' : 'assistant', text: (prior?.text ?? '') + params.delta, status: prior?.status ?? 'running'});
        }
    }
    private replace(message: HarnessMessage) {
        this.messages = mergeMessages(this.messages, [message]);
    }
    async send(text: string) {
        if (!this.loaded) await this.read();
        if (!text.trim() || !this.snapshot().canSend) throw new FSError('EBUSY', 'Conversation cannot send');
        this.draft = text;
        return this.mutate(async () => {
            if (!this.session) this.session = (await this.native('create', options => this.client.create(this.profile.id, this.workspaceId, options))).session;
            if (!this.session.owned) this.session = (await this.native('resume', options => this.client.resume(this.profile.id, this.session!.id, options))).session;
            const {turnId} = await this.native('turn', options => this.client.turn(this.profile.id, this.session!.id, text, options));
            if (!this.completed.has(turnId)) { this.session.activeTurnId = turnId; this.session.status = 'active'; }
            this.replace({id: `submitted:${turnId}`, role: 'user', text, turnId, timestamp: Date.now()});
        }).then(async snapshot => {
            this.draft = '';
            try { await this.save(); } catch { /* The native turn was committed; never resend it. */ }
            try { return await this.read(); } catch { this.disconnected = true; return {...snapshot, disconnected: true, canSend: false}; }
        });
    }
    async interrupt() {
        if (!this.snapshot().canInterrupt) throw new FSError('EACCES', 'Conversation cannot interrupt');
        return this.mutate(() => this.native('interrupt', options => this.client.interrupt(this.profile.id, this.session!.id, this.session!.activeTurnId!, options)));
    }
    async respond(id: string | number, response: Record<string, unknown>) {
        if (this.lifetime.signal.aborted || !this.writable || this.busy || this.pending || !this.session?.owned || !this.profile.capabilities.interactions || !this.requests.some(r => r.id === id))
            throw new FSError('EACCES', 'Interaction no longer pending or not owned');
        return this.mutate(async () => { await this.native('respond', options => this.client.respond(this.profile.id, id, response, options)); this.requests = this.requests.filter(r => r.id !== id); });
    }
    private async mutate(action: () => Promise<void>) {
        this.busy = true;
        try { await action(); } finally { this.busy = false; }
        return this.snapshot();
    }
    async reconcile() {
        if (!this.pending) return this.read();
        const receipt = await this.client.operation(this.profile.id, this.pending.requestId, {...this.options(), epoch: this.pending.epoch});
        if (receipt.outcome === 'unknown') return this.snapshot();
        const result = receipt.result as {session?: HarnessSession; turnId?: string} | undefined;
        if (receipt.outcome === 'committed') {
            if (['create', 'resume'].includes(this.pending.operation)) this.session = validateSession(result?.session);
            if (this.pending.operation === 'fork') this.navigationSessionId = validateSession(result?.session).id;
            if (this.pending.operation === 'turn' && typeof result?.turnId !== 'string') throw new FSError('EIO', 'Invalid turn receipt');
        }
        const pending = this.pending; this.pending = undefined;
        try { await this.save(); } catch (error) { this.pending = pending; throw error; }
        return this.read();
    }
    close(): Promise<void> {
        this.lifetime.abort();
        return this.closing ??= this.writes.then(() => this.client.close());
    }
}

/** Structural port for hosts; alternate transports do not inherit the implementation. */
export type HarnessConversationSnapshot = ReturnType<HarnessConversation['snapshot']>;
export interface HarnessConversationPort {
    readonly kind: string;
    snapshot(): HarnessConversationSnapshot;
    fork(name?: string): Promise<HarnessConversationSnapshot>;
    branches(): Promise<HarnessSession[]>;
    loadEarlier(): Promise<HarnessConversationSnapshot>;
    saveDraft(text: string): Promise<void>;
    read(): Promise<HarnessConversationSnapshot>;
    poll(): Promise<HarnessConversationSnapshot>;
    send(text: string): Promise<HarnessConversationSnapshot>;
    interrupt(): Promise<HarnessConversationSnapshot>;
    respond(id: string | number, response: Record<string, unknown>): Promise<HarnessConversationSnapshot>;
    reconcile(): Promise<HarnessConversationSnapshot>;
    close(): Promise<void>;
}
