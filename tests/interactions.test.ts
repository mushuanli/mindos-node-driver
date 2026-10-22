import {expect, it, vi} from 'vitest';
import {HarnessConversation} from '../src/harness/conversation';
import {nativeRequest} from '../src/harness/interactions';
import type {HarnessRecovery} from '../src/harness/conversation-journal';
const profile = {id: 'codex', kind: 'codex', projectRuntime: true, workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
const request = {id: 'q', method: 'item/tool/requestUserInput', params: {threadId: 's', questions: [
    {id: 'q', header: 'Choose', question: 'Choose', multiSelect: true, isSecret: false, isOther: true, options: [{label: 'A', description: 'First'}, {label: 'B'}]},
]}};
function fixture() {
    const client = {profiles: async () => ({epoch: 'e', profiles: [profile]}), read: async () => ({session: {id: 's', title: 'S', cwd: '/p', status: 'idle', owned: true, resumable: true}, turns: []}),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 1, gap: false, events: [], requests: [request]})),
        operation: vi.fn(async () => ({outcome: 'unknown', requestId: 'reply'})), respond: vi.fn(async () => {}), close: vi.fn(async () => {})};
    return client;
}
it('preserves native input semantics and rejects malformed structured questions explicitly', () => {
    expect(nativeRequest(request)[0].questions![0]).toMatchObject({header: 'Choose', multiSelect: true, isOther: true, options: [{label: 'A', description: 'First'}, {label: 'B'}]});
    expect(nativeRequest({...request, params: {questions: [{question: 'Missing ID'}]}})[0].kind).toBe('unsupported');
});
it('restores outstanding questions on initial read without requiring another execution event', async () => {
    const client = fixture(), first = new HarnessConversation(client as never, profile, 'p', 's');
    expect((await first.read()).requests).toHaveLength(1); await first.close();
    const reopened = new HarnessConversation(client as never, profile, 'p', 's');
    expect(await reopened.read()).toMatchObject({canRespond: true, requests: [{id: 'q', kind: 'input'}]}); await reopened.close();
});
it('persists unknown response receipts independently and never persists secret answers or repeats the reply', async () => {
    const client = fixture(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.respond.mockRejectedValueOnce({outcome: 'unknown'});
    const first = new HarnessConversation(client as never, profile, 'p', 's', true, journal); await first.read();
    await expect(first.respond('q', {answers: {q: {answers: ['private answer']}}})).rejects.toMatchObject({outcome: 'unknown'});
    expect(record!.responses).toHaveLength(1); expect(JSON.stringify(record)).not.toContain('private answer'); await first.close();
    const reopened = new HarnessConversation(client as never, profile, 'p', 's', true, journal); await reopened.read();
    expect(reopened.snapshot().requests[0].responding).toBe(true);
    await expect(reopened.respond('q', {answers: {}})).rejects.toMatchObject({code: 'EACCES'});
    expect(client.respond).toHaveBeenCalledOnce();
    client.operation.mockResolvedValue({outcome: 'committed', requestId: record!.responses![0].requestId} as never);
    client.eventSnapshot.mockResolvedValue({epoch: 'events', cursor: 2, gap: false, events: [], requests: []});
    expect((await reopened.reconcile()).requests).toEqual([]); expect(record!.responses).toEqual([]); await reopened.close();
});
