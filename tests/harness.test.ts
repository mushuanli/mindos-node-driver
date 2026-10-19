import { expect, it, vi } from 'vitest';
import {validateCommands} from '../src/harness/commands';
import { MCPHarnessClient } from '../src/harness/client';
import { createMindOSNodeClient } from '../src/provider';
import { validateEvents, validateHistory, validatePage, validateProfiles, validateSession } from '../src/harness/validation';

const session = { id: 's',title:'<script>x</script>',cwd:'/workspace',status:'idle',updatedAt:1,resumable:true };
it('validates optional native archive eligibility without accepting truthy values', () => {
    for (const archiveAllowed of [true, false]) expect(validateSession({...session, archiveAllowed}).archiveAllowed).toBe(archiveAllowed);
    for (const archiveAllowed of ['true', 1, null, {}]) expect(() => validateSession({...session, archiveAllowed})).toThrow();
});
it('retains profile aliases and rejects malformed alias metadata', () => {
    const profile = {id:'codex',kind:'codex',aliases:['codex-main'],workspaces:[],
        capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}};
    expect(validateProfiles({epoch:'e',profiles:[profile]}).profiles[0].aliases).toEqual(['codex-main']);
    for (const aliases of ['codex-main', [false], [''], Array(129).fill('old')])
        expect(() => validateProfiles({epoch:'e',profiles:[{...profile,aliases}]})).toThrow();
});
it('retains distinct creation and modification instants and accepts legacy native seconds without repeated conversion', () => {
    const legacy = {...session, title: ' ', updatedAt: 1791458565, native: {name: '', preview: 'Fix session navigation', createdAt: 1791458500}};
    const expected = {title: 'Fix session navigation', createdAt: 1791458500000, updatedAt: 1791458565000};
    const normalized = validatePage({sessions: [legacy], nextCursor: null}).sessions[0];
    expect(normalized).toMatchObject(expected); expect(validateSession(normalized)).toEqual(normalized);
    expect(validateHistory({session: legacy, turns: []}).session).toMatchObject(expected);
    expect(legacy.updatedAt).toBe(1791458565);
    expect(validateSession({...session, updatedAt: 0})).toMatchObject({createdAt: null, updatedAt: null});
    expect(() => validateSession({...session, createdAt: NaN})).toThrow();
});
it('carries an epoch and stable receipt identity, without replay after a lost response',async () => {
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'harness_profiles') return { epoch:'e',profiles:[] };
        if (name === 'harness_operation') return { outcome:'committed',requestId:args.requestId,result:{ session } };
        throw new Error('response lost');
    });
    const client = new MCPHarnessClient({ call,close:vi.fn() });
    const error = await client.create('codex','project').catch(e => e);
    expect(error.outcome).toBe('unknown'); expect(typeof error.requestId).toBe('string');
    expect(call.mock.calls.filter(([name]) => name === 'harness_create')).toHaveLength(1);
    expect(call.mock.calls[1][1]).toMatchObject({ epoch:'e',requestId:error.requestId });
    const receipt = await client.operation('codex',error.requestId);
    expect(receipt.outcome).toBe('committed');
    expect(call.mock.calls.filter(([name]) => name === 'harness_create')).toHaveLength(1);
});

it('keeps explicit refusal separate from unknown outcomes',async () => {
    const client = new MCPHarnessClient({ close:vi.fn(),call:async (name,args) => name === 'harness_profiles'
        ? { epoch:'e',profiles:[] } : { outcome:'not-committed',requestId:(args as { requestId:string }).requestId,code:'EACCES' } });
    await expect(client.resume('codex','s')).rejects.toMatchObject({ outcome:'not-committed',code:'EACCES' });
});

it('rejects malformed session, history, and event responses',() => {
    expect(() => validatePage({ sessions:[{...session,resumable:'true'}],nextCursor:null })).toThrow();
    expect(() => validateHistory({ session,turns:{} })).toThrow();
    expect(() => validateEvents({ epoch:'e',cursor:1,gap:false,events:[{seq:1,message:{}}],requests:[] })).toThrow();
    expect(() => validateEvents({epoch: 'e', cursor: 1, gap: false, events: [{seq: 1, timestamp: NaN, message: {method: 'item/started'}}], requests: []})).toThrow();
});

it('requests compact tool presentation for both history pages and live events', async () => {
    const call = vi.fn(async (name: string) => name === 'harness_session_read' ? {session, turns: [], nextCursor: null}
        : {epoch: 'e', cursor: 0, gap: false, events: [], requests: []});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    await client.read('codex', 's', {cursor: 'old', toolDetail: 'summary'});
    await client.events('codex', {after: 7, eventEpoch: 'events'}, {toolDetail: 'summary'});
    expect(call).toHaveBeenCalledWith('harness_session_read', {profileId: 'codex', sessionId: 's', cursor: 'old', toolDetail: 'summary'}, expect.anything());
    expect(call).toHaveBeenCalledWith('harness_events', {profileId: 'codex', after: 7, eventEpoch: 'events', toolDetail: 'summary'}, expect.anything());
});

it('uses the MCP v2 SDK and resolves updated credentials for each request',async () => {
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : await (_input as Request).clone().json();
        const result = body.method === 'server/discover'
            ? { resultType:'complete',ttlMs:0,cacheScope:'private',supportedVersions:['2026-07-28'],capabilities:{ tools:{} },_meta:{ 'io.modelcontextprotocol/serverInfo':{name:'test',version:'1'} } }
            : { resultType:'complete',content:[],structuredContent:{ epoch:'e',profiles:[] } };
        return new Response(JSON.stringify({ jsonrpc:'2.0',id:body.id,result }),{ headers:{ 'content-type':'application/json' } });
    });
    const adapter = createMindOSNodeClient(undefined,fetch);
    adapter.setCredential('ref','first');
    const client = adapter.harness({ endpoint:'http://localhost:8787',credentialRef:'ref' });
    await client.profiles(); adapter.setCredential('ref','second'); await client.profiles();
    expect(fetch.mock.calls.map(([,init]) => new Headers(init?.headers).get('authorization'))).toContain('Bearer second');
    expect(fetch.mock.calls.every(([,init]) => init?.redirect === 'error' && init.credentials === 'omit')).toBe(true);
    await adapter.dispose();
});

it('retains receipt identity when a committed payload cannot be decoded',async () => {
    const call = vi.fn(async (name: string, args: object) => name === 'harness_profiles'
        ? {epoch:'e',profiles:[]} : {outcome:'committed',requestId:(args as {requestId:string}).requestId,result:{session:{id:'broken'}}});
    const client = new MCPHarnessClient({call,close:vi.fn()});
    const error = await client.create('codex','project').catch(e => e);
    expect(error.outcome).toBe('unknown'); expect(typeof error.requestId).toBe('string');
    expect(call.mock.calls.filter(([name]) => name === 'harness_create')).toHaveLength(1);
});

it('uses the persisted mutation identity and queries the original epoch during recovery',async () => {
    const call=vi.fn(async (name:string,args:Record<string,unknown>) => name==='harness_profiles'
        ? {epoch:'current',profiles:[]} : {outcome:'committed',requestId:args.requestId,result:{session}});
    const client: import('../src/harness/contracts').HarnessClient=new MCPHarnessClient({call,close:vi.fn()});
    await client.create('codex','project',{requestId:'persisted',epoch:'original'});
    await client.operation('codex','persisted',{epoch:'original'});
    expect(call.mock.calls.find(([name])=>name==='harness_create')?.[1]).toMatchObject({requestId:'persisted',epoch:'original'});
    expect(call.mock.calls.find(([name])=>name==='harness_operation')?.[1]).toMatchObject({requestId:'persisted',epoch:'original'});
});

it('rejects a recovery receipt belonging to another request',async () => {
    const client=new MCPHarnessClient({call:vi.fn(async name=>name==='harness_profiles'?{epoch:'e',profiles:[]}:{outcome:'committed',requestId:'other',result:{session}}),close:vi.fn()});
    await expect(client.operation('codex','requested')).rejects.toMatchObject({code:'EIO'});
});

it('observes project directories only when discovered, validates responses and releases its token', async () => {
    const token = 'a'.repeat(32), call = vi.fn(async (name: string) => name === 'project_watch' ? {watchId: token, version: token + ':1', gap: false, truncated: false} : {released: true});
    const close = vi.fn(), metadata = vi.fn(async () => ({'itookit/pi-agent': {fileWatch: true}}));
    const client = new MCPHarnessClient({call, close, metadata}, {projectId: 'p', revision: 2, readOnly: true});
    expect(await client.directoryVersion()).toBe(token + ':1');
    await client.directoryVersion(); expect(call).toHaveBeenLastCalledWith('project_watch', {projectId: 'p', revision: 2, readOnly: true, watchId: token}, undefined);
    call.mockResolvedValueOnce({watchId: token, version: 'foreign:1', gap: false, truncated: false});
    await expect(client.directoryVersion()).rejects.toMatchObject({code: 'EIO'});
    await client.close(); expect(call).toHaveBeenLastCalledWith('project_unwatch', expect.objectContaining({watchId: token}), {timeoutMs: 2000}); expect(close).toHaveBeenCalledOnce();
    const old = new MCPHarnessClient({call, close}, {projectId: 'p', revision: 2});
    expect(await old.directoryVersion()).toBeUndefined(); expect(call).toHaveBeenCalledTimes(4);
});
it('never manufactures directory versions from elapsed time when watch coverage is partial', async () => {
    const token = 'b'.repeat(32), now = vi.spyOn(Date, 'now').mockReturnValue(30_000);
    const call = vi.fn(async () => ({watchId: token, version: token + ':0', gap: false, truncated: true}));
    const client = new MCPHarnessClient({call, close: vi.fn(), metadata: async () => ({'itookit/pi-agent': {fileWatch: true}})}, {projectId: 'p', revision: 1});
    try {
        const first = await client.directoryVersion(); now.mockReturnValue(60_000);
        expect(await client.directoryVersion()).toBe(first); expect(first).toBe(token + ':0');
    } finally {now.mockRestore();}
});

it.each(['missing', 'throws'])('uses the internal mutation ID generator when native UUID %s', async mode => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: original.getRandomValues.bind(original),
        ...(mode === 'throws' ? {randomUUID: () => {throw new Error('Native UUID unavailable');}} : {})});
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'harness_profiles' ? {epoch: 'e', profiles: []}
        : {outcome: 'committed', requestId: args.requestId, result: {session}});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    try {
        await client.create('codex', 'project');
        expect(call).toHaveBeenCalledWith('harness_create', expect.objectContaining({requestId: expect.stringMatching(/^[\da-f]{8}-[\da-f-]{27}$/i)}), undefined);
    } finally {await client.close(); vi.unstubAllGlobals();}
});
it('validates native catalogs and carries project scope plus stable command receipts', async () => {
    const commands = [{name: 'team:verify', description: 'Verify', argumentHint: '[path]', kind: 'prompt'}];
    const call = vi.fn(async (name: string, args: any) => name === 'harness_commands' ? {commands}
        : name === 'harness_profiles' ? {epoch: 'e', profiles: []}
        : {requestId: args.requestId, outcome: 'committed', result: {commandId: 'native', output: 'Done'}});
    const client = new MCPHarnessClient({call, close: vi.fn()}, {projectId: 'p', revision: 3});
    expect(await client.commands('claude', 's')).toEqual(commands);
    await client.command('claude', 's', 'team:verify', 'src', {requestId: 'once'});
    expect(call).toHaveBeenCalledWith('harness_commands', {profileId: 'claude', sessionId: 's', projectId: 'p', revision: 3}, undefined);
    expect(call).toHaveBeenCalledWith('harness_command', {profileId: 'claude', sessionId: 's', projectId: 'p', revision: 3,
        epoch: 'e', requestId: 'once', command: 'team:verify', arguments: 'src'}, {requestId: 'once'});
    for (const rows of [[...commands, ...commands], [{...commands[0], name: 'wrong name'}], [{...commands[0], kind: 'shell'}]])
        expect(() => validateCommands({commands: rows})).toThrow();
});
