import { expect, it } from 'vitest';
import { validateUsage } from '../src/harness/usage';
import { validateSession } from '../src/harness/validation';
import { MCPHarnessClient } from '../src/harness/client';
import { HarnessConversation } from '../src/harness/conversation';
const tokens = {inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 5};
const usage = {sessionId: 's', source: 'native-history', scope: 'transcript', revision: 'r1', complete: true, observedAt: Date.now(),
    totals: tokens, entries: [{id: 't', turnId: 't', providerId: 'openai', modelId: 'm', tokens}]};
const session = {id: 's', title: 'test', cwd: '/project', status: 'idle', resumable: true, updatedAt: Date.now(), usage};
it('validates usage identity, token buckets and totals without inferring money', () => {
    expect(validateUsage(usage, 's')).toEqual(usage);
    expect(validateSession(session).usage).toEqual(usage);
    for (const invalid of [ {...usage, sessionId: 'other'}, {...usage, totals: {...tokens, inputTokens: -1}},
        {...usage, entries: [...usage.entries, ...usage.entries]}, {...usage, totals: {...tokens, outputTokens: 21}} ]) {
        expect(() => validateUsage(invalid, 's')).toThrow('Invalid harness usage');
    }
});
it('queries the read-only usage capability with the authorized project scope', async () => {
    const calls: unknown[] = [];
    const client = new MCPHarnessClient({call: async (...args: unknown[]) => {calls.push(args); return usage;}, close: async () => {}}, {projectId: 'p', revision: 3});
    expect(await client.usage('codex-main', 's')).toEqual(usage);
    expect(calls[0]).toEqual(['harness_session_usage', {projectId: 'p', revision: 3, profileId: 'codex-main', sessionId: 's'}, undefined]);
});
it('uses piggybacked session usage without adding a poll or accumulating snapshots', async () => {
    const profile = {id: 'codex', kind: 'codex', workspaces: [], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
    const client = {eventSnapshot: async () => ({epoch:'e',cursor:0,gap:false,events:[],requests:[]}),read: async () => ({session, turns: []}), close: async () => {}};
    const c = new HarnessConversation(client as never, profile, 'w', 's');
    expect((await c.read()).usage?.totals.inputTokens).toBe(60);
    expect((await c.read()).usage?.totals.inputTokens).toBe(60);
    await c.close();
});
it('keeps old servers valid when no usage capability is available', () => {
    const {usage: _, ...legacy} = session;
    expect(validateSession(legacy).usage).toBeUndefined();
});

it('validates a frozen session without mutating its wire snapshot', () => {
    const frozen = Object.freeze({...session});
    expect(validateSession(frozen).usage).toEqual(usage);
    expect(frozen.usage).toBe(usage);
});
