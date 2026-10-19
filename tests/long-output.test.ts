import {expect, it, vi} from 'vitest';
import {HarnessConversation} from '../src/harness/conversation';
import {validateHistory} from '../src/harness/validation';

const profile = {id: 'codex', kind: 'codex', workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
const session = {id: 's', title: 'Long output', cwd: '/p', status: 'active', updatedAt: 1, owned: true, resumable: true, activeTurnId: 'turn'};
const text = 'Long response segment. '.repeat(8192);

it('resumes a long native snapshot at its event boundary after refresh and reopen', async () => {
    const client = {read: vi.fn(async () => ({session, turns: [{id: 'turn', items: [{id: 'a', type: 'agentMessage', text}]}], eventCursor: {after: 1500, eventEpoch: 'e'}})),
        events: vi.fn(async (_profile: string, cursor?: {after: number; eventEpoch: string}) => ({epoch: 'e', cursor: 1501, gap: false, requests: [], events: (cursor?.after ?? 0) < 1501
            ? [{seq: 1501, message: {method: 'item/agentMessage/delta', params: {threadId: 's', turnId: 'turn', itemId: 'a', delta: ' latest'}}}] : []})), close: async () => {}};
    for (let reopened = 0; reopened < 2; reopened++) {
        const view = new HarnessConversation(client as never, profile, 'p', 's');
        expect((await view.read()).messages[0].text).toBe(text);
        expect((await view.poll()).messages[0].text).toBe(text + ' latest');
        expect((await view.poll()).messages[0].text).toBe(text + ' latest');
        await view.close();
    }
    expect(client.events).toHaveBeenCalledWith('codex', {after: 1500, eventEpoch: 'e'}, expect.anything());
});

it('keeps the newer recovery cursor when repairing an overflowing replay buffer', async () => {
    let reads = 0;
    const client = {read: async () => ({session, turns: [{items: [{id: 'a', type: 'agentMessage', text}]}], eventCursor: {after: ++reads === 1 ? 1 : 1500, eventEpoch: 'e'}}),
        events: vi.fn(async (_profile: string, cursor?: {after: number; eventEpoch: string}) => ({epoch: 'e', cursor: cursor?.after === 1 ? 128 : cursor?.after ?? 0, gap: cursor?.after === 1, requests: [], events: []})), close: async () => {}};
    const view = new HarnessConversation(client as never, profile, 'p', 's'); await view.read();
    expect((await view.poll()).messages[0].text).toBe(text); await view.poll();
    expect(client.events.mock.calls.at(-1)?.[1]).toEqual({after: 1500, eventEpoch: 'e'}); await view.close();
});

it('rejects malformed native snapshot boundaries before using them', () => {
    for (const eventCursor of [{after: -1, eventEpoch: 'e'}, {after: 1.5, eventEpoch: 'e'}, {after: 1, eventEpoch: ''}])
        expect(() => validateHistory({session, turns: [], eventCursor})).toThrow();
});
