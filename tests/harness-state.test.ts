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
        eventSnapshot: vi.fn(async () => page), read: vi.fn(), resume: vi.fn(), turn: vi.fn(), close: vi.fn(async () => {})} as unknown as HarnessClient;
    let now = 100_000;
    return {client, observer: new HarnessStatusObserver(client, () => now), advance: () => { now += 15_001; }};
}
it('does not wake sidebar projections for text deltas, but immediately reports state changes', async () => {
    const {client,observer} = fixture(); let changed!: () => void;
    client.subscribe = vi.fn((_profile,listener) => { changed = listener; return () => {}; });
    const notified = vi.fn(), stop = observer.subscribe(notified); await observer.refresh();
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page,cursor:1,events:[{seq:1,message:{method:'item/agentMessage/delta',params:{threadId:'s',delta:'text'}}}]});
    changed(); await vi.waitFor(() => expect(client.eventSnapshot).toHaveBeenCalledTimes(2));
    expect(notified).not.toHaveBeenCalled();
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page,cursor:2,events:[{seq:2,message:{method:'turn/completed',params:{threadId:'s'}}}]});
    changed(); await vi.waitFor(() => expect(notified).toHaveBeenCalledOnce()); stop(); await observer.close();
});
it('replaces a complete authoritative list and removes sessions missing after an event gap', async () => {
    const {client, observer, advance} = fixture();
    await observer.refresh();
    vi.mocked(client.list).mockResolvedValue({sessions: [], nextCursor: null});
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, gap: true}); advance();
    expect(await observer.refresh()).toEqual([]);
    await observer.close();
});
it('retains the last complete snapshot when a later list page fails without installing partial changes', async () => {
    const {client, observer, advance} = fixture(); await observer.refresh(); advance();
    vi.mocked(client.list).mockResolvedValueOnce({sessions: [{...session, title: 'Partial title'}], nextCursor: 'next'})
        .mockRejectedValueOnce(new Error('Second page failed'));
    const rows = await observer.refresh();
    expect(rows).toEqual([expect.objectContaining({title: 'Title', observation: expect.objectContaining({stale: true, canRespond: false})})]);
    await observer.close();
});
it('marks truncated listings and preserves unseen sessions without claiming they were deleted', async () => {
    const {client, observer, advance} = fixture(); await observer.refresh(); advance();
    vi.mocked(client.list).mockImplementation(async (_profile, query) => ({sessions: [{...session, id: 'other'}], nextCursor: `${query?.cursor ?? ''}next`}));
    const rows = await observer.refresh();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.sessionId === 's')).toMatchObject({truncated: true,
        observation: {stale: true, refreshError: {code: 'LIST_TRUNCATED'}, canInterrupt: false, canRespond: false}});
    expect(rows.find(row => row.sessionId === 'other')).toMatchObject({truncated: true, observation: {stale: false}});
    await observer.close();
});
it('bounds a truncated session projection and recovers to a later complete empty snapshot', async () => {
    const {client, observer, advance} = fixture();
    vi.mocked(client.list).mockResolvedValue({sessions: Array.from({length: 513}, (_, i) => ({...session, id: String(i)})), nextCursor: null});
    const rows = await observer.refresh(); expect(rows).toHaveLength(512); expect(rows.every(row => row.truncated)).toBe(true);
    advance(); vi.mocked(client.list).mockResolvedValue({sessions: [], nextCursor: null});
    expect(await observer.refresh()).toEqual([]); await observer.close();
});
it('retains known sessions as stale when a truncated enumeration fills the entire observation budget', async () => {
    const {client, observer, advance} = fixture(); await observer.refresh(); advance();
    vi.mocked(client.list).mockResolvedValue({sessions: Array.from({length: 513}, (_, index) => ({...session, id: `new-${index}`})), nextCursor: null});
    const rows = await observer.refresh();
    expect(rows).toHaveLength(512);
    expect(rows.find(row => row.sessionId === 's')).toMatchObject({truncated: true,
        observation: {stale: true, refreshError: {code: 'LIST_TRUNCATED'}, canInterrupt: false, canRespond: false}});
    advance(); vi.mocked(client.list).mockResolvedValue({sessions: [], nextCursor: null});
    expect(await observer.refresh()).toEqual([]); await observer.close();
});
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
    const [first, second] = await Promise.all([observer.refresh(), observer.refresh()]);
    expect(first).toEqual(second); expect(first).toHaveLength(100);
    expect(client.eventSnapshot).toHaveBeenCalledOnce(); expect(client.list).toHaveBeenCalledTimes(4);
    await observer.refresh(); expect(client.list).toHaveBeenCalledTimes(4);
    expect(client.read).not.toHaveBeenCalled(); expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled();
    await observer.close();
});
it('repairs gaps and epochs with metadata, discards stale events, and keeps offline separate from failure', async () => {
    const {client, observer, advance} = fixture(); await observer.refresh();
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, epoch: 'new', gap: true, cursor: 1,
        events: [{seq: 1, message: {method: 'turn/started', params: {threadId: 's', turn: {id: 'old'}}}}]});
    expect((await observer.refresh())[0].observation.execution).toBe('idle'); expect(client.list).toHaveBeenCalledTimes(2);
    vi.mocked(client.eventSnapshot).mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await observer.refresh())[0].observation).toMatchObject({connection: 'offline', stale: true, lastResult: undefined});
    advance(); vi.mocked(client.eventSnapshot).mockResolvedValue({...page, epoch: 'new'});
    expect((await observer.refresh())[0].observation).toMatchObject({connection: 'online', stale: false});
});
it('does not overwrite a newer periodic list with older lifecycle events', async () => {
    const {client, observer, advance} = fixture(); await observer.refresh(); advance();
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, cursor: 1,
        events: [{seq: 1, message: {method: 'turn/started', params: {threadId: 's', turn: {id: 'earlier'}}}}]});
    expect((await observer.refresh())[0].observation.execution).toBe('idle');
});
it('keeps native disconnection evidence until a trustworthy snapshot confirms reconnection', async () => {
    const {client, observer, advance} = fixture(); await observer.refresh();
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, events: [{seq: 1, message: {method: 'harness/disconnected'}}]});
    expect((await observer.refresh())[0].observation.connection).toBe('offline');
    vi.mocked(client.eventSnapshot).mockResolvedValue(page);
    expect((await observer.refresh())[0].observation.connection).toBe('offline');
    advance(); expect((await observer.refresh())[0].observation.connection).toBe('online');
});
it('observes native title and archive changes and refreshes file revisions only for semantic events', async () => {
    const {client, observer} = fixture(); await observer.refresh();
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, cursor: 1, events: [{seq: 1, message: {method: 'thread/name/updated', params: {threadId: 's', threadName: 'Renamed'}}}]});
    expect((await observer.refresh())[0].title).toBe('Renamed');
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, cursor: 2, events: [{seq: 2, message: {method: 'item/agentMessage/delta', params: {threadId: 's', delta: 'text'}}}]});
    expect((await observer.refresh())[0].fileVersion).toBeUndefined();
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, cursor: 3, events: [{seq: 3, message: {method: 'item/completed', params: {threadId: 's', item: {type: 'fileChange'}}}}]});
    expect((await observer.refresh())[0].fileVersion).toBe('e:3');
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, cursor: 4, events: [{seq: 4, message: {method: 'thread/archived', params: {threadId: 's'}}}]});
    expect((await observer.refresh())[0]).toMatchObject({archived: true, observation: {owned: false, canInterrupt: false}});
});

it('keeps directory observation alive when there are no native sessions', async () => {
    const {client, observer} = fixture(); vi.mocked(client.profiles).mockResolvedValue({epoch: 'e', profiles: []});
    client.directorySnapshot = vi.fn(async () => 'watch:1'); expect(await observer.refresh()).toEqual([]);
    expect(observer.fileVersion()).toBe('watch:1'); expect(client.read).not.toHaveBeenCalled(); await observer.close();
});
it('can observe session activity without starting a directory watch', async () => {
    const {client} = fixture(); client.directorySnapshot = vi.fn(async () => 'watch:1');
    const observer = new HarnessStatusObserver(client, Date.now, true, false);
    expect((await observer.refresh())[0].observation.execution).toBe('idle');
    vi.mocked(client.eventSnapshot).mockResolvedValue({...page, cursor: 1,
        events: [{seq: 1, message: {method: 'turn/started', params: {threadId: 's', turn: {id: 't'}}}}]});
    expect((await observer.refresh())[0].observation.execution).toBe('running');
    expect(client.directorySnapshot).not.toHaveBeenCalled(); expect(observer.fileVersion()).toBeUndefined();
    await observer.close(); expect(client.close).toHaveBeenCalledOnce();
});
it('a disconnected Claude process does not disconnect another owned session', async () => {
    const {client, observer} = fixture(); vi.mocked(client.list).mockResolvedValue({sessions: [session, {...session, id: 'other'}], nextCursor: null});
    await observer.refresh(); vi.mocked(client.eventSnapshot).mockResolvedValue({...page, cursor: 1, events: [{seq: 1, message: {method: 'harness/disconnected', params: {threadId: 's'}}}]});
    const rows = await observer.refresh(); expect(rows.find(row => row.sessionId === 's')?.observation.connection).toBe('offline'); expect(rows.find(row => row.sessionId === 'other')?.observation.connection).toBe('online');
});

it('carries native update time without granting execution state or control permissions', () => {
    const updatedAt = Date.now();
    expect(harnessObservation({...session, status: 'notLoaded', updatedAt})).toMatchObject({updatedAt,
        execution: 'unknown', canInterrupt: false, canRespond: false, owned: false});
});

it('isolates directory watch failures and retains the last good file version', async () => {
    const {client, observer} = fixture();
    client.directorySnapshot = vi.fn().mockResolvedValueOnce('watch:1').mockRejectedValueOnce(new Error('watch failed')).mockResolvedValue('watch:2');
    await observer.refresh();
    expect((await observer.refresh())[0].observation).toMatchObject({connection: 'online', stale: false});
    expect(observer.fileVersion()).toBe('watch:1'); expect(client.eventSnapshot).toHaveBeenCalledTimes(2);
    await observer.refresh(); expect(observer.fileVersion()).toBe('watch:2');
});

it('isolates profile errors and recovers the failed transport immediately without new events', async () => {
    const {client, observer} = fixture(), descriptor = await client.profiles();
    vi.mocked(client.profiles).mockResolvedValue({...descriptor, profiles: [descriptor.profiles[0], {...descriptor.profiles[0], id: 'other'}]});
    await observer.refresh();
    vi.mocked(client.eventSnapshot).mockRejectedValueOnce(Object.assign(new Error('socket closed'), {code: 'ECONNRESET'}));
    const failed = await observer.refresh();
    expect(failed.find(row => row.profileId === 'p')?.observation).toMatchObject({connection: 'offline', stale: true});
    expect(failed.find(row => row.profileId === 'other')?.observation).toMatchObject({connection: 'online', stale: false});
    expect((await observer.refresh()).every(row => row.observation.connection === 'online')).toBe(true);
    expect(client.list).toHaveBeenCalledTimes(2);
});

it('reports protocol errors and timeouts as stale observations instead of lost connections', async () => {
    const {client, observer} = fixture(); await observer.refresh();
    for (const code of ['REQUEST_TIMEOUT', 'EIO', 'EACCES']) {
        vi.mocked(client.eventSnapshot).mockRejectedValueOnce(Object.assign(new Error('request failed'), {code}));
        expect((await observer.refresh())[0].observation).toMatchObject({connection: 'online', stale: true,
            refreshError: {stage: 'events', code}, canInterrupt: false, canRespond: false});
        const recovered = (await observer.refresh())[0].observation;
        expect(recovered).toMatchObject({connection: 'online', stale: false});
        expect(recovered.refreshError).toBeUndefined();
    }
});

it('does not turn metadata failure into a transport disconnection', async () => {
    const {client, observer, advance} = fixture(); await observer.refresh(); advance();
    vi.mocked(client.list).mockRejectedValueOnce(new Error('bad metadata'));
    expect((await observer.refresh())[0].observation).toMatchObject({connection: 'online', stale: true,
        refreshError: {stage: 'list', code: 'OBSERVATION_ERROR'}});
    expect((await observer.refresh())[0].observation).toMatchObject({connection: 'online', stale: false});
});

it.each(['ECONNRESET', 'EIO', 'EACCES', 'REQUEST_TIMEOUT'])('classifies list failure %s by transport evidence and isolates profiles', async code => {
    const {client, observer, advance} = fixture(), descriptor = await client.profiles();
    vi.mocked(client.profiles).mockResolvedValue({...descriptor, profiles: [descriptor.profiles[0], {...descriptor.profiles[0], id: 'other'}]});
    try {
        await observer.refresh(); advance();
        vi.mocked(client.list).mockRejectedValueOnce(Object.assign(new Error('request failed'), {code}));
        const failed = await observer.refresh();
        expect(failed.find(row => row.profileId === 'p')?.observation).toMatchObject({
            connection: code === 'ECONNRESET' ? 'offline' : 'online', stale: true,
            refreshError: {stage: 'list', code}, canInterrupt: false, canRespond: false,
        });
        expect(failed.find(row => row.profileId === 'other')?.observation).toMatchObject({connection: 'online', stale: false});
        const recovered = (await observer.refresh()).find(row => row.profileId === 'p')!.observation;
        expect(recovered).toMatchObject({connection: 'online', stale: false});
        expect(recovered.refreshError).toBeUndefined();
    } finally {await observer.close();}
});
