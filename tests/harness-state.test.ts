import { expect, it, vi } from 'vitest';
import { harnessObservation, applyHarnessStatus } from '../src/harness/state';
import { HarnessStatusObserver } from '../src/harness/status-observer';
import { validateSession } from '../src/harness/validation';
import type { HarnessClient, HarnessSession, HarnessEvents } from '../src/harness/contracts';

const session: HarnessSession = {id: 's', title: 'Title', cwd: '/workspace', status: 'idle', updatedAt: 1, resumable: true, owned: false};
const page: HarnessEvents = {epoch: 'e', cursor: 0, gap: false, events: [], requests: []};
function fixture() {
    const client = {profiles: vi.fn(async () => ({epoch: 'e', profiles: [{id: 'p', projectRuntime: true, capabilities: {history: true}}]})),
        list: vi.fn(async () => ({sessions: [session], nextCursor: null})),
        events: vi.fn(async () => page), read: vi.fn(), resume: vi.fn(), turn: vi.fn(), close: vi.fn(async () => {})} as unknown as HarnessClient;
    let now = 100_000;
    return {client, observer: new HarnessStatusObserver(client, () => now), advance: () => { now += 15_001; }};
}
it('preserves unknown and notLoaded without inferring completion or failure', () => {
    for (const status of [null, 'notLoaded', 'futureStatus', 'systemError'])
        expect(harnessObservation({...session, status})).toMatchObject({execution: 'unknown', lastResult: undefined});
    expect(harnessObservation({...session, status: 'systemError'}).nativeError).toBe(true);
    expect(harnessObservation({...session, status: 'active', statusDetails: {type: 'active', activeFlags: ['waitingOnApproval']}}).execution).toBe('waiting-approval');
    expect(harnessObservation({...session, status: 'active'}, [{kind: 'input'}]).execution).toBe('waiting-input');
    expect(harnessObservation(session, [], {connection: 'offline', receiptUnknown: true})).toMatchObject({execution: 'idle', connection: 'offline', receiptUnknown: true});
});
it('keeps turn results separate from execution and ignores unrelated turns and text deltas', () => {
    const running = applyHarnessStatus(session, {method: 'turn/started', params: {threadId: 's', turn: {id: 't'}}});
    expect(harnessObservation(running).execution).toBe('running');
    expect(applyHarnessStatus(running, {method: 'item/agentMessage/delta', params: {threadId: 's', delta: 'text'}})).toBe(running);
    expect(applyHarnessStatus(running, {method: 'turn/completed', params: {threadId: 's', turn: {id: 'old', status: 'failed'}}})).toBe(running);
    for (const [status, result] of [['failed', 'failed'], ['interrupted', 'cancelled'], ['completed', 'completed']]) {
        const ended = applyHarnessStatus(running, {method: 'turn/completed', params: {threadId: 's', turn: {id: 't', status}}});
        expect(harnessObservation(ended)).toMatchObject({execution: 'idle', lastResult: result});
    }
});
it('validates native status evidence rather than trusting malformed flags', () => {
    expect(() => validateSession({...session, statusDetails: {type: 'active', activeFlags: [1]}})).toThrow();
    expect(validateSession({...session, lastTurnResult: null}).lastTurnResult).toBeUndefined();
});
it('observes 100 unopened sessions with four list pages and one event request, never reading or resuming histories', async () => {
    const {client, observer} = fixture();
    vi.mocked(client.list).mockImplementation(async (_id, query) => {
        const start = Number(query?.cursor ?? 0);
        return {sessions: Array.from({length: 25}, (_, i) => ({...session, id: String(start + i)})), nextCursor: start < 75 ? String(start + 25) : null};
    });
    const [first, second] = await Promise.all([observer.poll(), observer.poll()]);
    expect(first).toEqual(second); expect(first).toHaveLength(100);
    expect(client.events).toHaveBeenCalledOnce(); expect(client.list).toHaveBeenCalledTimes(4);
    await observer.poll(); expect(client.list).toHaveBeenCalledTimes(4);
    expect(client.read).not.toHaveBeenCalled(); expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled();
    await observer.close();
});
it('repairs gaps and epochs with metadata, discards stale events, and keeps offline separate from failure', async () => {
    const {client, observer, advance} = fixture(); await observer.poll();
    vi.mocked(client.events).mockResolvedValue({...page, epoch: 'new', gap: true, cursor: 1,
        events: [{seq: 1, message: {method: 'turn/started', params: {threadId: 's', turn: {id: 'old'}}}}]});
    expect((await observer.poll())[0].observation.execution).toBe('idle'); expect(client.list).toHaveBeenCalledTimes(2);
    vi.mocked(client.events).mockRejectedValueOnce(new Error('offline'));
    expect((await observer.poll())[0].observation).toMatchObject({connection: 'offline', stale: true, lastResult: undefined});
    advance(); vi.mocked(client.events).mockResolvedValue({...page, epoch: 'new'});
    expect((await observer.poll())[0].observation).toMatchObject({connection: 'online', stale: false});
});
it('does not overwrite a newer periodic list with older lifecycle events', async () => {
    const {client, observer, advance} = fixture(); await observer.poll(); advance();
    vi.mocked(client.events).mockResolvedValue({...page, cursor: 1,
        events: [{seq: 1, message: {method: 'turn/started', params: {threadId: 's', turn: {id: 'earlier'}}}}]});
    expect((await observer.poll())[0].observation.execution).toBe('idle');
});
it('keeps native disconnection evidence until a trustworthy snapshot confirms reconnection', async () => {
    const {client, observer, advance} = fixture(); await observer.poll();
    vi.mocked(client.events).mockResolvedValue({...page, events: [{seq: 1, message: {method: 'harness/disconnected'}}]});
    expect((await observer.poll())[0].observation.connection).toBe('offline');
    vi.mocked(client.events).mockResolvedValue(page);
    expect((await observer.poll())[0].observation.connection).toBe('offline');
    advance(); expect((await observer.poll())[0].observation.connection).toBe('online');
});
it('observes native title and archive changes and refreshes file revisions only for semantic events', async () => {
    const {client, observer} = fixture(); await observer.poll();
    vi.mocked(client.events).mockResolvedValue({...page, cursor: 1, events: [{seq: 1, message: {method: 'thread/name/updated', params: {threadId: 's', threadName: 'Renamed'}}}]});
    expect((await observer.poll())[0].title).toBe('Renamed');
    vi.mocked(client.events).mockResolvedValue({...page, cursor: 2, events: [{seq: 2, message: {method: 'item/agentMessage/delta', params: {threadId: 's', delta: 'text'}}}]});
    expect((await observer.poll())[0].fileVersion).toBeUndefined();
    vi.mocked(client.events).mockResolvedValue({...page, cursor: 3, events: [{seq: 3, message: {method: 'item/completed', params: {threadId: 's', item: {type: 'fileChange'}}}}]});
    expect((await observer.poll())[0].fileVersion).toBe('e:3');
    vi.mocked(client.events).mockResolvedValue({...page, cursor: 4, events: [{seq: 4, message: {method: 'thread/archived', params: {threadId: 's'}}}]});
    expect((await observer.poll())[0]).toMatchObject({archived: true, observation: {owned: false, canInterrupt: false}});
});

it('keeps directory observation alive when there are no native sessions', async () => {
    const {client, observer} = fixture(); vi.mocked(client.profiles).mockResolvedValue({epoch: 'e', profiles: []});
    client.directoryVersion = vi.fn(async () => 'watch:1'); expect(await observer.poll()).toEqual([]);
    expect(observer.fileVersion()).toBe('watch:1'); expect(client.read).not.toHaveBeenCalled(); await observer.close();
});
it('a disconnected Claude process does not disconnect another owned session', async () => {
    const {client, observer} = fixture(); vi.mocked(client.list).mockResolvedValue({sessions: [session, {...session, id: 'other'}], nextCursor: null});
    await observer.poll(); vi.mocked(client.events).mockResolvedValue({...page, cursor: 1, events: [{seq: 1, message: {method: 'harness/disconnected', params: {threadId: 's'}}}]});
    const rows = await observer.poll(); expect(rows.find(row => row.sessionId === 's')?.observation.connection).toBe('offline'); expect(rows.find(row => row.sessionId === 'other')?.observation.connection).toBe('online');
});
