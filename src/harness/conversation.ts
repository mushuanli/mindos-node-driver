import {validateModels, validateModelSelection, validateAvailableSelection} from './models';
import type {HarnessCommandResult, HarnessModelCatalog, HarnessModelSelection} from './contracts';
import {validateCommands, validateCommandResult, validateCommandReceipts} from './commands';
import { requestId as createRequestId } from '../files/request-id';
import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessClient, HarnessProfile, HarnessSession, HarnessEvents, HarnessAttachment } from './contracts';
import { conversationBranches } from './branches';
import { validateAttachments, validateDeletedSessionIds, validateSession } from './validation';
import { applyHarnessStatus, harnessObservation, harnessArchiveAllowed } from './state';
import { ObservationErrors, connectionLost, type HarnessObservationError } from './observation-errors';
import {validateSubmission, type HarnessConversationJournal} from './conversation-journal';
import { mergeMessages, historyMessages, nativeMessage, nativeRequest, type HarnessMessage, type HarnessRequest } from './conversation-model';

/** One native conversation; closing a viewer never interrupts its remote turn. */
export class HarnessConversation implements HarnessConversationPort {
    async models(): Promise<HarnessModelCatalog> {
        if (!this.profile.capabilities.models || !this.client.models) return {models: []};
        return validateModels(await this.client.models(this.profile.id, this.session?.id, this.options()));
    }
    private nativeCommands: import('./contracts').HarnessSlashCommand[] = [];
    async commands() {
        if (!this.profile.capabilities.slashCommands || !this.client.commands) return [];
        this.nativeCommands = await this.client.commands(this.profile.id, this.session?.id, this.options());
        return this.availableCommands();
    }
    private availableCommands() {
        return this.nativeCommands.map(command => ({...command, ...(!this.session && command.kind === 'action' ? {disabled: true} : {})}));
    }
    async command(name: string, args = '', selection?: HarnessModelSelection, inputText?: string, submissionId?: string) {
        const requested = selection ? validateModelSelection(selection) : undefined;
        if (!this.loaded || Date.now() - this.observedAt > 30_000) await this.read();
        if (!this.snapshot().canSend || !this.client.command) throw new FSError('ECAPABILITY', 'Native command unavailable');
        const command = (await this.commands()).find(row => row.name === name);
        const canonical = `/${name}${args ? ' ' + args : ''}`;
        const text = inputText ?? (this.draft.trim() === canonical.trim() ? this.draft : canonical);
        if (!this.snapshot().canSend || !command || command.disabled || args.length > 128 * 1024 || text.length > 1024 * 1024) throw new FSError('EINVAL', 'Unknown native command');
        if (!this.session && command.kind !== 'prompt') throw new FSError('ECAPABILITY', 'Native command requires a session');
        const selected = requested && command.kind === 'prompt' ? validateAvailableSelection(requested, await this.models()) : undefined;
        if (!this.snapshot().canSend) throw new FSError('EBUSY', 'Native command unavailable');
        if (!this.draft) this.setDraft(text, []);
        this.startSubmission(submissionId);
        const submission = {inputText: text, draftRevision: this.draftRevision};
        this.submittedTurnId = undefined;
        return this.mutate(async () => {
            await this.prepareSession();
            await this.native('command', options => this.client.command!(this.profile.id, this.session!.id, name, args,
                {...options, ...(selected ? {selection: selected} : {})}), submission, result => this.acceptCommand(result, text));
        }).then(() => this.refreshSubmitted());
    }
    private session?: HarnessSession;
    private messages: HarnessMessage[] = [];
    private requests: HarnessRequest[] = [];
    private responses: NonNullable<import('./conversation-journal').HarnessRecovery['responses']> = [];
    private responseBusy = new Set<string>();
    private cursor?: {after: number; eventEpoch: string};
    private readonly completed = new Set<string>();
    private readonly completedItems = new Set<string>();
    private pending?: import('./conversation-journal').HarnessRecovery['pending'];
    private draftRevision = 0;
    private commandResults: HarnessCommandResult[] = [];
    private deletedSessionIds: string[] = [];
    private loaded = false;
    private earlier?: string;
    private expandedHistory = false;
    private readonly historyCursors = new Set<string>();
    private navigationSessionId?: string;
    private draft = '';
    private submittedTurnId?: string;
    private submission?: import('./conversation-journal').HarnessRecovery['submission'];
    private draftAttachments: HarnessAttachment[] = [];
    private writes: Promise<void> = Promise.resolve();
    private disconnected = false;
    private nativeDisconnected = false;
    private refreshError?: HarnessObservationError;
    private readonly errors: ObservationErrors;
    private gap = false;
    private busy = false;
    private observedAt = 0;
    private source: 'history' | 'events' = 'history';
    private inspectedAt = 0;
    private closing?: Promise<void>;
    private readonly lifetime = new AbortController();
    constructor(private readonly client: HarnessClient, private readonly profile: HarnessProfile,
        private readonly workspaceId: string, sessionId?: string, private readonly writable = true, private readonly journal?: HarnessConversationJournal) {
        this.errors = new ObservationErrors(profile.id, sessionId);
        if (sessionId) this.session = {id: sessionId, title: sessionId, cwd: null, status: null, updatedAt: null, resumable: false};
    }
    get kind() { return this.profile.kind; }
    private options(): OperationOptions { return {signal: this.lifetime.signal, timeoutMs: 30_000}; }
    snapshot() {
        const active = !!this.session?.activeTurnId || this.session?.status === 'active';
        const observation = harnessObservation(this.session, this.requests, {observedAt: this.observedAt, source: this.source,
            connection: this.disconnected || this.nativeDisconnected ? 'offline' : 'online',
            refreshError: this.refreshError, stale: !!this.refreshError || Date.now() - this.observedAt > 30_000,
            receiptUnknown: !!this.pending || !!this.responses.length});
        const available = observation.connection === 'online' && !observation.stale;
        const controllable = !this.deletedSessionIds.length && !this.lifetime.signal.aborted && available && this.writable && !this.busy && !this.pending && !!this.session?.owned;
        const manageable = !this.deletedSessionIds.length && this.loaded && !!this.session && !this.lifetime.signal.aborted && available && this.writable && !this.busy && !this.pending;
        observation.canInterrupt = controllable && !!this.session?.activeTurnId && this.profile.capabilities.interrupt;
        observation.canRespond = !this.deletedSessionIds.length && !this.lifetime.signal.aborted && available && this.writable
            && this.pending?.operation !== 'respond' && !!this.session?.owned && this.profile.capabilities.interactions && this.requests.some(r => r.kind !== 'unsupported' && !this.responses.some(p => p.id === r.id));
        return {...(this.profile.capabilities.models ? {supportsModels: true} : {}), ...(this.profile.capabilities.slashCommands ? {supportsSlashCommands: true} : {}), ...(this.nativeCommands.length ? {slashCommands: this.availableCommands()} : {}), usage: this.session?.usage, usageUnavailable: this.session?.usageUnavailable, observation, submission: this.submission ? {...this.submission} : undefined, submittedTurnId: this.submittedTurnId, draft: this.draft, draftAttachments: structuredClone(this.draftAttachments), sessionId: this.navigationSessionId ?? this.session?.id, title: this.session?.title.trim() || this.profile.kind,
            attachments: this.writable ? this.profile.capabilities.attachments : undefined,
            deletedSessionIds: this.deletedSessionIds.slice(),
            canDelete: manageable && !!this.client.delete && !!this.profile.capabilities.delete
                && (observation.execution === 'idle' && !!this.session?.owned || !!this.session?.archived && this.session?.status === 'notLoaded'),
            archived: !!this.session?.archived,
            canRename: manageable && !!this.client.rename && !!this.profile.capabilities.rename,
            canArchive: manageable && harnessArchiveAllowed(this.session) && !!this.client.archive && !!this.profile.capabilities.archive,
            canUnarchive: manageable && !!this.session?.archived && !!this.client.archive && !!this.profile.capabilities.unarchive,
            createdAt: this.session?.createdAt, updatedAt: this.session?.updatedAt,
            branchName: this.session?.branchName ?? (this.session?.parentSessionId ? undefined : 'main'),
            messages: mergeMessages(this.messages, this.commandMessages()).map(m => ({...m})), requests: this.requests.map(r => ({...r, responding: this.responses.some(p => p.id === r.id)})),
            hasEarlier: !!this.earlier,
            canFork: !this.deletedSessionIds.length && !this.session?.archived && !this.lifetime.signal.aborted && this.loaded && this.writable && !this.busy && !active && !this.pending && !this.disconnected && !this.nativeDisconnected && !this.refreshError && !this.navigationSessionId && !!this.session && this.messages.some(message => message.role === 'user' || message.role === 'assistant') && !!this.client.fork && !!this.profile.capabilities.fork && this.session.forkable !== false,
            canSend: !this.deletedSessionIds.length && !this.session?.archived && !this.navigationSessionId && this.loaded && !this.lifetime.signal.aborted && this.writable && !this.busy && !active && !this.pending && !this.responses.length && !this.requests.length && !this.disconnected && !this.nativeDisconnected && !this.refreshError && (this.session ? this.session.resumable && (this.session.owned || this.profile.capabilities.resume) : this.profile.capabilities.create),
            canInterrupt: observation.canInterrupt,
            canRespond: observation.canRespond,
            active, pending: !!this.pending || !!this.responses.length, disconnected: this.disconnected || this.nativeDisconnected, gap: this.gap};
    }
    private async restore() {
        if (this.loaded) return;
        const record = await this.journal?.load();
        if (record?.sessionId && !this.session) this.session = {id: record.sessionId, title: record.sessionId, cwd: null, status: null, updatedAt: null, resumable: false};
        this.deletedSessionIds = record?.deletedSessionIds ?? [];
        this.pending = record?.pending; this.draft = record?.draft ?? '';
        this.responses = record?.responses?.map(row => ({...row})) ?? [];
        this.submittedTurnId = record?.submittedTurnId;
        this.submission = validateSubmission(record?.submission);
        this.draftRevision = record?.draftRevision ?? 0;
        this.commandResults = validateCommandReceipts(record?.commandResults);
        this.draftAttachments = validateAttachments(record?.draftAttachments); this.loaded = true;
    }
    private save(sessionId = this.session?.id): Promise<void> {
        const record = {sessionId, responses: this.responses.map(row => ({...row})), submission: this.submission ? {...this.submission} : undefined, submittedTurnId: this.submittedTurnId, deletedSessionIds: this.deletedSessionIds, pending: this.pending, draft: this.draft,
            draftAttachments: this.draftAttachments, draftRevision: this.draftRevision, commandResults: this.commandResults};
        const write = this.writes.then(() => this.journal?.save(record));
        this.writes = write.catch(() => {}); return write;
    }
    async saveDraft(text: string, attachments: HarnessAttachment[] = []) {
        await this.restore();
        if (text.length > 1024 * 1024) throw new FSError('EFBIG', 'Remote input draft too large');
        this.setDraft(text, validateAttachments(attachments)); await this.save();
    }
    private setDraft(text: string, attachments: HarnessAttachment[]): void {
        if (text !== this.draft || JSON.stringify(attachments) !== JSON.stringify(this.draftAttachments)) ++this.draftRevision;
        this.draft = text; this.draftAttachments = attachments;
    }
    private acceptDraft(submission: {inputText?: string; draftRevision?: number}): void {
        if (submission.draftRevision !== undefined && submission.draftRevision !== this.draftRevision) return;
        if (submission.inputText !== undefined && submission.inputText !== this.draft) return;
        this.setDraft('', []);
    }
    private startSubmission(id?: string): void {
        if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new FSError('EINVAL', 'Invalid submission identity');
        if (id && this.submission?.id === id) throw new FSError('ECONFLICT', 'Submission already tracked; reconcile its receipt');
        this.submission = id ? {id, status: 'pending'} : undefined;
    }
    private acceptSubmission(turnId?: string): void {
        if (this.submission?.status === 'pending') this.submission = {id: this.submission.id, status: 'accepted', turnId};
    }
    private rejectSubmission(): void {
        if (this.submission?.status === 'pending') this.submission = {id: this.submission.id, status: 'rejected'};
    }
    private async prepareSession(): Promise<void> {
        if (!this.session) this.session = (await this.native('create', options => this.client.create(this.profile.id, this.workspaceId, options))).session;
        else if (this.client.inspect) this.session = (await this.client.inspect(this.profile.id, this.session.id, this.options())).session;
        if (!this.session.owned) this.session = (await this.native('resume', options => this.client.resume(this.profile.id, this.session!.id, options))).session;
    }
    private async refreshSubmitted(): Promise<HarnessConversationSnapshot> {
        try {return await this.read();}
        catch (error) {
            this.disconnected = connectionLost(error);
            this.refreshError = this.errors.record('history', error);
            return this.snapshot();
        }
    }
    private acceptCommand(value: unknown, inputText: string): void {
        const result = validateCommandResult(value);
        this.submittedTurnId = result.turnId;
        this.acceptSubmission(result.turnId);
        if (result.commandId) {
            const record = {commandId: result.commandId, output: result.output ?? inputText, failed: result.failed};
            this.commandResults = [...this.commandResults.filter(row => row.commandId !== result.commandId), record].slice(-64);
        }
        if (result.turnId && !this.completed.has(result.turnId)) {this.session!.activeTurnId = result.turnId; this.session!.status = 'active';}
    }
    private commandMessages(): HarnessMessage[] {
        const nativeIds = new Set(this.messages.map(message => message.id));
        return this.commandResults.filter(row => row.commandId && !nativeIds.has(`command:${row.commandId}`)).map(row => ({
            id: `command:${row.commandId}`, role: 'system', text: row.output ?? '', status: row.failed ? 'failed' : 'completed'}));
    }
    private async native<T>(operation: string, call: (options: import('./contracts').HarnessMutationOptions) => Promise<T>,
        submission?: {inputText: string; draftRevision: number}, committed?: (result: T) => void): Promise<T> {
        const epoch = this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
        const requestId = ['turn', 'command'].includes(operation) && this.submission?.status === 'pending' ? this.submission.id : createRequestId();
        this.pending = {requestId, epoch, operation, ...submission};
        try {
            try { await this.save(); } catch (error) { this.pending = undefined; throw error; }
            const result = await call({...this.options(), ...this.pending});
            const session = (result as {session?: HarnessSession} | undefined)?.session;
            if (operation === 'delete') this.deletedSessionIds = (result as {deletedSessionIds: string[]}).deletedSessionIds;
            committed?.(result);
            if (operation === 'turn' || operation === 'command' && !this.draftAttachments.length) this.acceptDraft(this.pending);
            const pending = this.pending; this.pending = undefined;
            try { await this.save(session?.id ?? this.session?.id); } catch (error) { this.pending = pending; throw error; }
            return result;
        } catch (error) {
            if ((error as {outcome?: string})?.outcome === 'not-committed') {
                this.rejectSubmission(); this.pending = undefined; await this.save();
            } else if (this.pending && error && typeof error === 'object') Object.assign(error, {outcome: 'unknown'});
            throw error;
        }
    }
    async read(): Promise<HarnessConversationSnapshot> {
        await this.restore();
        if (this.pending?.operation === 'delete') return this.reconcile();
        if (this.deletedSessionIds.length) return this.snapshot();
        if (this.session) {
            const history = await this.client.read(this.profile.id, this.session.id, {...this.options(), toolDetail: 'summary'});
            const messages = historyMessages(history);
            this.messages = this.expandedHistory ? mergeMessages(this.messages, messages) : messages;
            this.session = {...history.session, lastTurnResult: history.session.lastTurnResult ?? this.session.lastTurnResult};
            if (history.eventCursor) this.cursor = {...history.eventCursor};
            this.observedAt = Date.now(); this.source = 'history'; this.gap = false;
            if (!this.expandedHistory) { this.earlier = history.nextCursor ?? undefined; this.historyCursors.clear(); }
            for (const message of this.messages) if (message.status === 'completed') this.completedItems.add(message.id);
            while (this.completedItems.size > 1000) this.completedItems.delete(this.completedItems.values().next().value!);
        }
        this.disconnected = this.nativeDisconnected = false;
        this.refreshError = undefined; this.errors.clear('history');
        if (this.session) {
            try {
                const page = await this.client.events(this.profile.id, this.cursor, {...this.options(), toolDetail: 'summary'});
                this.requests = page.requests.filter(r => r.params?.threadId === this.session!.id).flatMap(nativeRequest);
                await this.reconcileResponses();
            } catch (error) {this.refreshError = this.errors.record('events', error);}
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
        if (this.deletedSessionIds.length) return this.snapshot();
        let stage = 'events';
        try {
            const page = await this.client.events(this.profile.id, this.cursor, {...this.options(), toolDetail: 'summary'});
            this.disconnected = false;
            const repair = page.gap || !!this.cursor && this.cursor.eventEpoch !== page.epoch;
            if (repair && this.busy) {
                this.consume({...page, events: []}); this.gap = true;
                this.errors.clear('events');
                return this.snapshot();
            }
            if (repair) { stage = 'history'; await this.read(); this.gap = true; }
            stage = 'projection';
            if (!repair) this.consume(page);
            if (!repair && !this.busy) {stage = 'inspect'; await this.inspect(page);}
            if (!repair && page.events.some(e => e.message.method === 'turn/completed' && e.message.params?.threadId === this.session?.id)) {
                stage = 'history'; await this.read();
            }
            if (!this.cursor || this.cursor.eventEpoch !== page.epoch || this.cursor.after < page.cursor)
                this.cursor = {after: page.cursor, eventEpoch: page.epoch};
            this.refreshError = undefined;
            for (const recovered of ['events', 'projection', 'inspect', 'history']) this.errors.clear(recovered);
        } catch (error) {
            if (this.lifetime.signal.aborted) throw error;
            this.disconnected = connectionLost(error);
            this.refreshError = this.errors.record(stage, error);
        }
        return this.snapshot();
    }
    private async inspect(page: HarnessEvents): Promise<void> {
        if (!this.session || !this.client.inspect || Date.now() - this.inspectedAt < 15_000) return;
        this.session = (await this.client.inspect(this.profile.id, this.session.id, this.options())).session;
        this.observedAt = Date.now(); this.inspectedAt = this.observedAt;
        this.requests = page.requests.filter(r => r.params?.threadId === this.session?.id).flatMap(nativeRequest);
        this.nativeDisconnected = false;
    }
    private consume(page: HarnessEvents) {
        for (const {message, timestamp} of page.events) {
            if (message.method === 'harness/disconnected' && (!message.params?.threadId || message.params.threadId === this.session?.id)) this.nativeDisconnected = true;
            if (!this.session || message.params?.threadId !== this.session.id) continue;
            this.consumeEvent(message.method, message.params, timestamp);
        }
        this.requests = page.requests.filter(r => this.session && r.params?.threadId === this.session.id).flatMap(nativeRequest);
        if (this.requests.length) { this.observedAt = Date.now(); this.source = 'events'; }
    }
    private consumeEvent(method: string, params: Record<string, unknown>, at?: number) {
        if (method === 'harness/commands/updated') this.nativeCommands = validateCommands({commands: params.commands});
        const prior = this.session!;
        this.session = applyHarnessStatus(prior, {method, params});
        if (this.session !== prior) {
            this.observedAt = Date.now(); this.source = 'events'; this.gap = false;
            if (['thread/status/changed', 'turn/started', 'turn/completed'].includes(method)) this.nativeDisconnected = false;
        }
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
    async send(text: string, attachments?: HarnessAttachment[], selection?: HarnessModelSelection, submissionId?: string) {
        const requested = selection ? validateModelSelection(selection) : undefined;
        if (!this.loaded || Date.now() - this.observedAt > 30_000) await this.read();
        if (!text.trim() || !this.snapshot().canSend) throw new FSError('EBUSY', 'Conversation cannot send');
        if (attachments?.some(file => !this.profile.capabilities.attachments?.includes(file.kind))) throw new FSError('ECAPABILITY', 'Attachment kind unavailable');
        const prepared = validateAttachments(attachments);
        const selected = requested ? validateAvailableSelection(requested, await this.models()) : undefined;
        if (!this.snapshot().canSend) throw new FSError('EBUSY', 'Conversation cannot send');
        this.submittedTurnId = undefined;
        this.setDraft(text, prepared);
        this.startSubmission(submissionId);
        const submission = {inputText: text, draftRevision: this.draftRevision};
        return this.mutate(async () => {
            await this.prepareSession();
            await this.native('turn', options => this.client.turn(this.profile.id, this.session!.id, text,
                {...options, ...(selected ? {selection: selected} : {}), ...(prepared.length ? {attachments: prepared} : {})}), submission, ({turnId}) => {
                this.submittedTurnId = turnId;
                this.acceptSubmission(turnId);
                if (!this.completed.has(turnId)) { this.session!.activeTurnId = turnId; this.session!.status = 'active'; }
                this.replace({id: `submitted:${turnId}`, role: 'user', text, turnId, timestamp: Date.now()});
            });
        }).then(() => this.refreshSubmitted());
    }
    async interrupt() {
        if (!this.snapshot().canInterrupt) throw new FSError('EACCES', 'Conversation cannot interrupt');
        return this.mutate(() => this.native('interrupt', options => this.client.interrupt(this.profile.id, this.session!.id, this.session!.activeTurnId!, options)));
    }
    async rename(name: string) {
        if (!this.snapshot().canRename || !name.trim() || new TextEncoder().encode(name.trim()).byteLength > 512 || /[\x00-\x1f\x7f]/.test(name)) throw new FSError('EACCES', 'Native rename unavailable');
        return this.mutate(async () => {
            this.session = (await this.native('rename', options => this.client.rename!(this.profile.id, this.session!.id, name.trim(), options))).session;
            this.observedAt = Date.now();
        });
    }
    async archive(archived: boolean) {
        if (!(archived ? this.snapshot().canArchive : this.snapshot().canUnarchive)) throw new FSError('EACCES', 'Native archive operation unavailable');
        return this.mutate(async () => {
            this.session = (await this.native(archived ? 'archive' : 'unarchive', options => this.client.archive!(this.profile.id, this.session!.id, archived, options))).session;
            this.observedAt = Date.now();
        });
    }
    async delete() {
        if (!this.snapshot().canDelete) throw new FSError('EACCES', 'Native deletion unavailable');
        return this.mutate(async () => {
            const result = await this.native('delete', options => this.client.delete!(this.profile.id, this.session!.id, options));
            this.deletedSessionIds = result.deletedSessionIds; this.messages = []; this.requests = [];
            this.commandResults = []; this.setDraft('', []); await this.save();
        });
    }
    async respond(id: string | number, response: Record<string, unknown>) {
        const request = this.requests.find(r => r.id === id && r.kind !== 'unsupported');
        if (this.lifetime.signal.aborted || !this.writable || this.pending?.operation === 'respond' || !this.session?.owned || !this.profile.capabilities.interactions || !request || this.responses.some(p => p.id === id))
            throw new FSError('EACCES', 'Interaction no longer pending or not owned');
        const epoch = this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
        if (this.responses.some(p => p.id === id)) throw new FSError('EBUSY', 'Response already pending');
        const pending = {id, epoch, requestId: createRequestId()};
        this.responses.push(pending); this.responseBusy.add(pending.requestId);
        let sent = false;
        try {
            await this.save();
            sent = true;
            await this.client.respond(this.profile.id, id, response, {...this.options(), ...pending});
            this.requests = this.requests.filter(r => r.id !== id);
            this.responses = this.responses.filter(p => p !== pending); await this.save();
        } catch (error) {
            if (!sent || (error as {outcome?: string})?.outcome === 'not-committed') {this.responses = this.responses.filter(p => p !== pending); await this.save();}
            throw error;
        } finally {this.responseBusy.delete(pending.requestId);}
        return this.snapshot();
    }
    private async reconcileResponses(): Promise<void> {
        for (const pending of [...this.responses]) {
            if (this.responseBusy.has(pending.requestId)) continue;
            const receipt = await this.client.operation(this.profile.id, pending.requestId, {...this.options(), epoch: pending.epoch});
            if (receipt.outcome === 'unknown') continue;
            if (receipt.outcome === 'committed') this.requests = this.requests.filter(r => r.id !== pending.id);
            this.responses = this.responses.filter(p => p !== pending); await this.save();
        }
    }
    private async mutate(action: () => Promise<void>) {
        this.busy = true;
        try { await action(); } finally { this.busy = false; }
        return this.snapshot();
    }
    async reconcile(submissionId?: string): Promise<HarnessConversationSnapshot> {
        await this.restore();
        await this.reconcileResponses();
        if (!this.pending) {
            if (submissionId && (this.submission?.id !== submissionId || this.submission.status === 'pending')) await this.reconcileSubmission(submissionId);
            return this.read();
        }
        if (submissionId && this.submission?.id !== submissionId) return this.snapshot();
        const receipt = await this.client.operation(this.profile.id, this.pending.requestId, {...this.options(), epoch: this.pending.epoch});
        if (receipt.outcome === 'unknown') return this.snapshot();
        const result = receipt.result as {session?: HarnessSession; turnId?: string; deletedSessionIds?: string[]} | undefined;
        if (receipt.outcome === 'committed') {
            if (['create', 'resume', 'rename', 'archive', 'unarchive'].includes(this.pending.operation)) this.session = validateSession(result?.session);
            if (this.pending.operation === 'delete') {
                this.deletedSessionIds = validateDeletedSessionIds(result?.deletedSessionIds, this.session!.id); this.messages = []; this.requests = [];
                this.commandResults = []; this.setDraft('', []);
            }
            if (this.pending.operation === 'fork') this.navigationSessionId = validateSession(result?.session).id;
            if (this.pending.operation === 'command') {
                this.acceptCommand(result, this.pending.inputText ?? '');
                if (!this.draftAttachments.length) this.acceptDraft(this.pending);
            }
            if (this.pending.operation === 'turn') {
                if (typeof result?.turnId !== 'string') throw new FSError('EIO', 'Invalid turn receipt');
                this.submittedTurnId = result.turnId;
                this.acceptSubmission(result.turnId);
                this.acceptDraft(this.pending);
            }
        }
        if (receipt.outcome !== 'committed' || ['create', 'resume'].includes(this.pending.operation)) this.rejectSubmission();
        const pending = this.pending; this.pending = undefined;
        try { await this.save(); } catch (error) { this.pending = pending; throw error; }
        return this.read();
    }
    private async reconcileSubmission(id: string): Promise<void> {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new FSError('EINVAL', 'Invalid submission identity');
        const epoch = this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
        const receipt = await this.client.operation(this.profile.id, id, {...this.options(), epoch});
        if (receipt.requestId !== id) throw new FSError('EIO', 'Mismatched submission receipt');
        if (receipt.outcome === 'unknown') return;
        const result = receipt.result as {turnId?: unknown} | undefined;
        const turnId = typeof result?.turnId === 'string' ? result.turnId : undefined;
        this.submission = {id, status: receipt.outcome === 'committed' ? 'accepted' : 'rejected', turnId};
        if (turnId) this.submittedTurnId = turnId;
        await this.save();
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
    commands?(): Promise<import('./contracts').HarnessSlashCommand[]>;
    command?(name: string, args?: string, selection?: HarnessModelSelection, inputText?: string, submissionId?: string): Promise<HarnessConversationSnapshot>;
    snapshot(): HarnessConversationSnapshot;
    delete?(): Promise<HarnessConversationSnapshot>;
    rename?(name: string): Promise<HarnessConversationSnapshot>;
    archive?(archived: boolean): Promise<HarnessConversationSnapshot>;
    fork(name?: string): Promise<HarnessConversationSnapshot>;
    branches(): Promise<HarnessSession[]>;
    loadEarlier(): Promise<HarnessConversationSnapshot>;
    saveDraft(text: string, attachments?: HarnessAttachment[]): Promise<void>;
    read(): Promise<HarnessConversationSnapshot>;
    poll(): Promise<HarnessConversationSnapshot>;
    models?(): Promise<HarnessModelCatalog>;
    send(text: string, attachments?: HarnessAttachment[], selection?: HarnessModelSelection, submissionId?: string): Promise<HarnessConversationSnapshot>;
    interrupt(): Promise<HarnessConversationSnapshot>;
    respond(id: string | number, response: Record<string, unknown>): Promise<HarnessConversationSnapshot>;
    reconcile(submissionId?: string): Promise<HarnessConversationSnapshot>;
    close(): Promise<void>;
}
