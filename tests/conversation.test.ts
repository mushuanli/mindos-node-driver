import { expect, it, vi } from 'vitest';
import { HarnessConversation } from '../src/harness/conversation';
import type { HarnessClient, HarnessProfile } from '../src/harness/contracts';
import type { HarnessRecovery } from '../src/harness/conversation-journal';
import { historyMessages, mergeMessages } from '../src/harness/conversation-model';
import { toolSummary } from '../src/harness/tool-summary';
const profile: HarnessProfile = {id:'codex', kind:'codex', projectRuntime:true, workspaces:[{id:'p'}], capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}};
const session = {id:'s', title:'Title', cwd:'/projects/p', status:'idle', updatedAt:1, resumable:true, owned:true};
function peer(): HarnessClient {
    return {profiles:vi.fn(async () => ({epoch:'e',profiles:[profile]})), list:vi.fn(), read:vi.fn(async () => ({session:{...session}, turns:[{items:[{id:'a',type:'agentMessage',text:'native history'}]}]})),
        create:vi.fn(async () => ({session:{...session}})), resume:vi.fn(async () => ({session:{...session}})), turn:vi.fn(async () => ({turnId:'t'})),
        interrupt:vi.fn(async () => {}), respond:vi.fn(async () => {}), operation:vi.fn(), close:vi.fn(async () => {}),
        events:vi.fn(async () => ({epoch:'events',cursor:1,gap:false,events:[],requests:[]}))};
}
it('projects native roles, keeps stream items distinct and replaces deltas with finalized content', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's');
    await view.read();
    vi.mocked(client.events).mockResolvedValue({epoch:'events',cursor:2,gap:false,requests:[],events:[
        {seq:1,message:{method:'item/agentMessage/delta',params:{threadId:'other',itemId:'a',delta:'wrong'}}},
        {seq:2,message:{method:'item/agentMessage/delta',params:{threadId:'s',itemId:'b',delta:'draft'}}},
        {seq:3,message:{method:'item/completed',params:{threadId:'s',item:{id:'b',type:'agentMessage',text:'final'}}}},
        {seq:4,message:{method:'item/agentMessage/delta',params:{threadId:'s',itemId:'b',delta:'late'}}}
    ]});
    const state = await view.poll();
    expect(state.messages.map(m => m.text)).toEqual(['native history','final']);
    await view.close(); expect(client.interrupt).not.toHaveBeenCalled();
});
it('repairs an event gap from native history without appending already recorded deltas', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.events).mockResolvedValue({epoch:'events',cursor:2,gap:true,requests:[],events:[{seq:1,message:{method:'item/agentMessage/delta',params:{threadId:'s',itemId:'a',delta:'duplicate'}}}]});
    const state = await view.poll(); expect(state.gap).toBe(true); expect(state.messages[0].text).toBe('native history');
});
it('persists mutation identity before creation and blocks replay after reopening an unknown result', async () => {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch:'original', load:async () => record, save:async (value: HarnessRecovery) => {record=structuredClone(value);}};
    vi.mocked(client.create).mockImplementation(async (_p,_w,options) => {
        expect(record?.pending?.requestId).toBe(options?.requestId);
        throw {outcome:'unknown',requestId:options?.requestId};
    });
    const first = new HarnessConversation(client, profile, 'p', undefined, true, journal);
    await expect(first.send('task')).rejects.toMatchObject({outcome:'unknown'});
    expect(first.snapshot().pending).toBe(true); expect(record?.draft).toBe('task'); await first.close();
    const next = new HarnessConversation(client, profile, 'p', undefined, true, {...journal,epoch:'replacement'});
    await next.read(); await expect(next.send('task')).rejects.toMatchObject({code:'EBUSY'});
    expect(client.create).toHaveBeenCalledOnce();
    vi.mocked(client.operation).mockResolvedValue({outcome:'committed',requestId:record!.pending!.requestId,result:{session}});
    const confirmed = await next.reconcile(); expect(confirmed.sessionId).toBe('s'); expect(confirmed.pending).toBe(false);
    expect(client.operation).toHaveBeenCalledWith('codex',expect.any(String),expect.objectContaining({epoch:'original'}));
});
it('keeps a successfully committed turn accepted when its history refresh fails', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.read).mockRejectedValueOnce(new Error('history offline'));
    const state = await view.send('task');
    expect(state.disconnected).toBe(false); expect(state.canSend).toBe(false);
    expect(state.observation).toMatchObject({stale: true, refreshError: {stage: 'history', code: 'OBSERVATION_ERROR'}});
    expect(client.turn).toHaveBeenCalledOnce();
});

it('distinguishes projection and inspect failures from network loss and clears recovered errors', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    client.inspect = vi.fn().mockRejectedValueOnce(Object.assign(new Error('bad reply'), {code: 'EIO'}))
        .mockResolvedValue({session: {...session}});
    expect(await view.poll()).toMatchObject({disconnected: false, observation: {stale: true, refreshError: {stage: 'inspect', code: 'EIO'}}});
    expect((await view.poll()).observation.refreshError).toBeUndefined();
    vi.mocked(client.events).mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await view.poll()).disconnected).toBe(true);
    expect((await view.read()).disconnected).toBe(false);
    expect((await view.poll()).observation.refreshError).toBeUndefined();
    await view.close();
});

it('keeps native process disconnection separate from a healthy empty event response', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.events).mockResolvedValueOnce({epoch:'e',cursor:1,gap:false,requests:[],events:[
        {seq:1,message:{method:'harness/disconnected',params:{threadId:'s'}}}]} );
    expect((await view.poll()).disconnected).toBe(true);
    vi.mocked(client.events).mockResolvedValue({epoch:'e',cursor:1,gap:false,requests:[],events:[]});
    expect((await view.poll()).disconnected).toBe(true);
    expect((await view.read()).disconnected).toBe(false);
    await view.close();
});

it('disables native controls after a process disconnect even while its last activity is fresh', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'active', activeTurnId: 't'}, turns: []});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    expect(view.snapshot().canInterrupt).toBe(true);
    vi.mocked(client.events).mockResolvedValue({epoch: 'e', cursor: 1, gap: false, requests: [], events: [
        {seq: 1, message: {method: 'harness/disconnected', params: {threadId: 's'}}}]});
    expect(await view.poll()).toMatchObject({disconnected: true, canInterrupt: false, canRespond: false, canSend: false, canRename: false});
    await view.close();
});
it('denies sending, interruption and approvals for an attenuated read-only project', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's', false); await view.read();
    expect(view.snapshot()).toMatchObject({canSend:false,canRespond:false,canInterrupt:false});
    await expect(view.send('task')).rejects.toMatchObject({code:'EBUSY'}); await expect(view.respond(1,{decision:'accept'})).rejects.toMatchObject({code:'EACCES'});
    expect(client.turn).not.toHaveBeenCalled(); expect(client.respond).not.toHaveBeenCalled();
});

it('persists unsent input across view closure while keeping native history remote', async () => {
    const client=peer();let record:HarnessRecovery | undefined;
    const journal={epoch:'e',load:async () => record,save:async (value:HarnessRecovery) => {record=structuredClone(value);}};
    const first=new HarnessConversation(client,profile,'p','s',true,journal);await first.read();await first.saveDraft('unsent task');await first.close();
    const next=new HarnessConversation(client,profile,'p','s',true,journal);expect((await next.read()).draft).toBe('unsent task');
    expect(record).not.toHaveProperty('messages');expect(client.turn).not.toHaveBeenCalled();
});

it('loads earlier history by stable native IDs without duplicating the current page',async () => {
    const client=peer();
    vi.mocked(client.read).mockResolvedValueOnce({session,turns:[{items:[{id:'recent',type:'agentMessage',text:'Latest'}]}],nextCursor:'200'});
    const view=new HarnessConversation(client,profile,'p','s');expect((await view.read()).hasEarlier).toBe(true);
    vi.mocked(client.read).mockResolvedValueOnce({session,turns:[{items:[{id:'earlier',type:'userMessage',text:'Earlier'}]}],nextCursor:null});
    const state=await view.loadEarlier();expect(state.messages.map(m=>m.text)).toEqual(['Earlier','Latest']);expect(state.hasEarlier).toBe(false);
    expect(client.read).toHaveBeenLastCalledWith('codex','s',expect.objectContaining({cursor:'200'}));await view.close();
});
it('creates a native branch and recovers an unknown fork without replaying it',async () => {
    const client=peer();client.fork=vi.fn(async () => {throw {outcome:'unknown'};});
    let record:HarnessRecovery | undefined;
    const journal={epoch:'e',load:async()=>record,save:async (value:HarnessRecovery)=>{record=structuredClone(value);}};
    const forkProfile={...profile,capabilities:{...profile.capabilities,fork:true}};
    const view=new HarnessConversation(client,forkProfile,'p','s',true,journal);await view.read();
    expect(view.snapshot().canFork).toBe(true);await expect(view.fork('Alternative')).rejects.toMatchObject({outcome:'unknown'});
    expect(view.snapshot()).toMatchObject({pending:true,canFork:false});
    const reopened=new HarnessConversation(client,forkProfile,'p','s',true,journal);await reopened.read();
    const branch={...session,id:'branch',parentSessionId:'s'};
    vi.mocked(client.operation).mockResolvedValue({outcome:'committed',requestId:record!.pending!.requestId,result:{session:branch}});
    expect(await reopened.reconcile()).toMatchObject({sessionId:'branch',pending:false,canSend:false});
    expect(client.fork).toHaveBeenCalledOnce();expect(record?.pending).toBeUndefined();
    await view.close();await reopened.close();
});
it('groups native siblings and nested branches, excluding independent sessions across list pages',async () => {
    const client=peer(),view=new HarnessConversation(client,profile,'p','s');await view.read();
    vi.mocked(client.list).mockResolvedValueOnce({sessions:[session,{...session,id:'branch',parentSessionId:'s'},{...session,id:'other'}],nextCursor:'p2'})
        .mockResolvedValueOnce({sessions:[{...session,id:'nested',parentSessionId:'branch'}],nextCursor:null});
    expect((await view.branches()).map(s=>s.id)).toEqual(['s','branch','nested']);await view.close();
});

it('uses parent links refreshed from listing when the history summary omitted them',async()=>{
    const client=peer();vi.mocked(client.read).mockResolvedValueOnce({session:{...session,id:'child'},turns:[]});
    vi.mocked(client.list).mockResolvedValue({sessions:[session,{...session,id:'child',parentSessionId:'s'}],nextCursor:null});
    const view=new HarnessConversation(client,profile,'p','child');await view.read();
    expect((await view.branches()).map(item=>item.id)).toEqual(['child','s']);await view.close();
});

it('retains native turn identities and compact tool targets while ignoring tool output deltas', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [{id: 'native-turn', items: [
        {id: 'u', type: 'userMessage', content: [{text: 'Inspect files'}]},
        {id: 'reasoning', type: 'reasoning', summary: [{text: 'Check the references'}]},
        {id: 'bash', type: 'commandExecution', command: 'rg pattern .', aggregatedOutput: 'file.ts', status: 'completed'},
        {id: 'a', type: 'agentMessage', text: 'Found files'},
    ]}]});
    const view = new HarnessConversation(client, profile, 'p', 's'); const initial = await view.read();
    expect(initial.messages.map(message => message.turnId)).toEqual(['native-turn', 'native-turn', 'native-turn', 'native-turn']);
    expect(initial.messages[1]).toMatchObject({role: 'system', text: 'Check the references'});
    expect(initial.messages[2]).toMatchObject({name: 'commandExecution', paths: ['.'], operation: 'search'});
    expect(initial.messages[2]).not.toHaveProperty('input'); expect(initial.messages[2].text).not.toContain('file.ts');
    vi.mocked(client.events).mockResolvedValueOnce({epoch: 'events', cursor: 2, gap: false, requests: [], events: [
        {seq: 1, message: {method: 'item/started', params: {threadId: 's', turnId: 'next-turn', item: {id: 'live-tool', type: 'commandExecution', command: 'pwd', aggregatedOutput: 'starting', status: 'inProgress'}}}},
        {seq: 2, message: {method: 'item/commandExecution/outputDelta', params: {threadId: 's', turnId: 'next-turn', itemId: 'live-tool', delta: '\n/project'}}},
    ]});
    const current = await view.poll();
    expect(current.messages.find(message => message.id === 'live-tool')).toMatchObject({turnId: 'next-turn', text: 'commandExecution', operation: 'execute'});
    expect(client.read).toHaveBeenCalledWith('codex', 's', expect.objectContaining({toolDetail: 'summary'}));
    expect(client.events).toHaveBeenCalledWith('codex', undefined, expect.objectContaining({toolDetail: 'summary'}));
    await view.close();
});

it('preserves every request and response in native content arrays with real times and turn IDs', () => {
    const messages = historyMessages({session, turns: [{id: 'rollout-history', items: [
        {id: 'u', turnId: 't1', type: 'userMessage', timestamp: '2026-10-08T11:22:45Z', content: [{text: 'Request one'}, [{text: 'Request two'}, {content: [{text: 'Request three'}]}]]},
        {id: 'a1', turnId: 't1', type: 'agentMessage', timestamp: 1791458566, content: [{text: 'Answer one'}, {text: 'Answer two'}]},
        {id: 'a2', turnId: 't1', type: 'agentMessage', timestamp: 1791458567000, text: 'Answer three'},
        {id: 'u2', turnId: 't2', type: 'userMessage', content: [{text: 'Next request'}]},
    ]}]});
    expect(messages.map(message => message.text)).toEqual(['Request one\nRequest two\nRequest three', 'Answer one\nAnswer two', 'Answer three', 'Next request']);
    expect(messages[0].contentParts).toEqual(['Request one', 'Request two', 'Request three']);
    expect(messages[1]).not.toHaveProperty('contentParts');
    expect(messages.map(message => message.turnId)).toEqual(['t1', 't1', 't1', 't2']);
    expect(messages.map(message => message.timestamp)).toEqual([1791458565000, 1791458566000, 1791458567000, undefined]);
});

it('keeps explicit context provenance aligned with every flattened native text part', () => {
    const [message] = historyMessages({session, turns: [{id: 't', items: [{id: 'u', type: 'userMessage',
        content: [{text: '# AGENTS.md instructions'}, {content: [{text: 'first request'}, {text: 'second request'}]}],
        contentItemKinds: ['agents_md.instructions', 'user.text']}]}]});
    expect(message.contentParts).toEqual(['# AGENTS.md instructions', 'first request', 'second request']);
    expect(message.contentPartKinds).toEqual(['agents_md.instructions', 'user.text', 'user.text']);
    expect(message.text).toBe('# AGENTS.md instructions\nfirst request\nsecond request');
});
it('ignores absent or misaligned provenance without inferring context from prompt contents', () => {
    for (const kinds of [undefined, [], ['agents_md.instructions', 'user.text'], [1]]) {
        const [message] = historyMessages({session, turns: [{items: [{id: 'u', type: 'userMessage',
            content: [{text: '<environment_context>literal user request</environment_context>'}], contentItemKinds: kinds}]}]});
        expect(message.contentPartKinds).toBeUndefined();
        expect(message.text).toContain('literal user request');
    }
});

it('keeps loaded earlier history during refresh without silently discarding messages above the old budget', async () => {
    const client = peer(), text = 'x'.repeat(90_000);
    const page = (start: number) => Array.from({length: 20}, (_, index) => ({id: String(start + index), type: 'agentMessage', text}));
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [{items: page(20)}], nextCursor: 'earlier'})
        .mockResolvedValueOnce({session, turns: [{items: [...page(0), page(20)[0]]}], nextCursor: null})
        .mockResolvedValueOnce({session, turns: [{items: [...page(20), {id: 'new', type: 'agentMessage', text: 'Latest'}]}], nextCursor: 'earlier'});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    expect((await view.loadEarlier()).messages).toHaveLength(40);
    const refreshed = await view.read();
    expect(refreshed.messages).toHaveLength(41); expect(refreshed.messages[0].id).toBe('0');
    expect(refreshed.messages.at(-1)?.text).toBe('Latest'); expect(refreshed.hasEarlier).toBe(false);
    await view.close();
});

it('reports capacity overflow explicitly and preserves the existing history and paging cursor', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [{items: [{id: 'latest', type: 'agentMessage', text: 'Latest'}]}], nextCursor: 'earlier'})
        .mockResolvedValueOnce({session, turns: [{items: Array.from({length: 10_000}, (_, index) => ({id: String(index), type: 'agentMessage', text: 'Earlier'}))}], nextCursor: null});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    await expect(view.loadEarlier()).rejects.toMatchObject({code: 'EFBIG'});
    expect(view.snapshot().messages.map(message => message.text)).toEqual(['Latest']); expect(view.snapshot().hasEarlier).toBe(true);
    await view.close();
});

it('places backfilled native items before newer streamed items using their recorded timestamps', () => {
    const first = [{id: 'one', role: 'assistant' as const, text: 'First', timestamp: 1000}, {id: 'three', role: 'assistant' as const, text: 'Live', timestamp: 3000}];
    const second = [{...first[0], text: 'Final first'}, {id: 'two', role: 'tool' as const, text: 'Tool', timestamp: 2000}];
    expect(mergeMessages(first, second).map(message => message.text)).toEqual(['Final first', 'Tool', 'Live']);
    expect(mergeMessages(first.map(message => ({...message, timestamp: undefined})), second.map(message => ({...message, timestamp: undefined}))).map(message => message.text)).toEqual(['Final first', 'Live', 'Tool']);
});

it('summarizes declared tool targets without showing unrelated command content or search patterns', () => {
    for (const command of ['curl -H Authorization:Bearer.header.value https://example.com', 'node -e private.code.value', 'echo private.code.value']) {
        expect(toolSummary({command}, 'commandExecution').paths).toEqual([]);
    }
    expect(toolSummary({command: 'rg pattern.ts src/main.ts'}, 'commandExecution').paths).toEqual(['src/main.ts']);
    expect(toolSummary({command: 'cat "src/my file.ts"'}, 'commandExecution').paths).toEqual([]);
    expect(toolSummary({changes: [{path: 'src/my file.ts', diff: 'private patch'}]}, 'fileChange')).toMatchObject({paths: ['src/my file.ts'], operation: 'write'});
});
it('retains only the first command line and declared files when compacting exec tools', () => {
    const native = {type: 'toolCall', name: 'exec', arguments: JSON.stringify({cmd: '\n pnpm typecheck \ncat private-output', workdir: '/project'})};
    const summary = toolSummary(native, 'toolCall');
    expect(summary).toMatchObject({commandPreview: 'pnpm typecheck', paths: ['/project'], operation: 'execute'});
    expect(toolSummary(summary, 'toolCall')).toEqual(summary);
    expect(JSON.stringify(summary)).not.toContain('private-output');
    expect(toolSummary({command: 'x'.repeat(300)}, 'commandExecution').commandPreview).toHaveLength(241);
    expect(toolSummary({name: 'exec', input: 'await tools.exec_command({cmd: "pnpm build"})\n// second line'}, 'toolCall').commandPreview)
        .toBe('await tools.exec_command({cmd: "pnpm build"})');
});
it('rejects cyclic history cursors without overwriting already loaded history', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [], nextCursor: 'first'})
        .mockResolvedValueOnce({session, turns: [{items: [{id: 'middle', type: 'agentMessage', text: 'Middle'}]}], nextCursor: 'second'})
        .mockResolvedValueOnce({session, turns: [], nextCursor: 'first'});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read(); await view.loadEarlier();
    await expect(view.loadEarlier()).rejects.toMatchObject({code: 'EIO'});
    expect(view.snapshot().messages.map(message => message.text)).toEqual(['Middle']);
    expect(view.snapshot().hasEarlier).toBe(true); await view.close();
});

it('renames and archives native metadata through receipts without resuming or sending', async () => {
    const client = peer(), managed = {...profile, capabilities: {...profile.capabilities, rename: true, archive: true, unarchive: true}};
    client.rename = vi.fn(async (_p, _s, name) => ({session: {...session, title: name}}));
    client.archive = vi.fn(async (_p, _s, archived) => ({session: {...session, archived, owned: false}}));
    const view = new HarnessConversation(client, managed, 'p', 's'); await view.read();
    expect((await view.rename('Native name')).title).toBe('Native name');
    expect((await view.archive(true))).toMatchObject({archived: true, canSend: false, canUnarchive: true});
    expect((await view.archive(false))).toMatchObject({archived: false, canArchive: false});
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled(); await view.close();
});
it('persists unknown native management outcomes and prevents mutation replay after reopening', async () => {
    const client = peer(), managed = {...profile, capabilities: {...profile.capabilities, rename: true}};
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (next: HarnessRecovery) => {record = structuredClone(next);}};
    client.rename = vi.fn(async () => {throw {outcome: 'unknown'};});
    const first = new HarnessConversation(client, managed, 'p', 's', true, journal); await first.read();
    await expect(first.rename('Saved elsewhere')).rejects.toMatchObject({outcome: 'unknown'}); await first.close();
    const next = new HarnessConversation(client, managed, 'p', 's', true, journal); await next.read();
    await expect(next.rename('Saved elsewhere')).rejects.toMatchObject({code: 'EACCES'});
    expect(client.rename).toHaveBeenCalledOnce();
    vi.mocked(client.operation).mockResolvedValue({requestId: record!.pending!.requestId, outcome: 'committed', result: {session: {...session, title: 'Saved elsewhere'}}});
    vi.mocked(client.read).mockResolvedValue({session: {...session, title: 'Saved elsewhere'}, turns: []});
    expect((await next.reconcile()).pending).toBe(false); await next.close();
});
it('denies metadata mutations on read-only, unsupported, busy and unowned archive targets', async () => {
    const client = peer(), managed = {...profile, capabilities: {...profile.capabilities, rename: true, archive: true}};
    client.rename = vi.fn(); client.archive = vi.fn();
    const readonly = new HarnessConversation(client, managed, 'p', 's', false); await readonly.read();
    await expect(readonly.rename('Denied')).rejects.toMatchObject({code: 'EACCES'});
    await expect(readonly.archive(true)).rejects.toMatchObject({code: 'EACCES'});
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'idle', owned: false}, turns: []});
    const external = new HarnessConversation(client, managed, 'p', 's'); await external.read();
    await expect(external.archive(true)).rejects.toMatchObject({code: 'EACCES'});
    expect(client.archive).not.toHaveBeenCalled(); await readonly.close(); await external.close();
});
it('uses native archive eligibility for idle unowned sessions without resuming them', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, archive: true}};
    vi.mocked(client.read).mockResolvedValue({session: {...session, owned: false, archiveAllowed: true}, turns: []});
    client.archive = vi.fn(async () => ({session: {...session, owned: false, archived: true, archiveAllowed: false}}));
    const view = new HarnessConversation(client, capable, 'p', 's');
    expect(await view.read()).toMatchObject({canArchive: true});
    expect(await view.archive(true)).toMatchObject({archived: true, canArchive: false});
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled();
    await view.close();
});

it('preserves attachment drafts through closure and unknown receipts without replaying a native turn', async () => {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    const capable = {...profile, capabilities: {...profile.capabilities, attachments: ['text' as const]}};
    const attachments = [{kind: 'text' as const, name: 'notes.md', content: 'quoted "text"\n中文'}];
    const first = new HarnessConversation(client, capable, 'p', 's', true, journal);
    await first.saveDraft('Review', attachments); await first.close();
    const next = new HarnessConversation(client, capable, 'p', 's', true, journal);
    expect((await next.read()).draftAttachments).toEqual(attachments);
    vi.mocked(client.turn).mockRejectedValueOnce({outcome: 'unknown'});
    await expect(next.send('Review', attachments)).rejects.toMatchObject({outcome: 'unknown'});
    expect(record?.draftAttachments).toEqual(attachments);
    await expect(next.send('Review', attachments)).rejects.toMatchObject({code: 'EBUSY'});
    vi.mocked(client.operation).mockResolvedValue({outcome: 'committed', requestId: record!.pending!.requestId, result: {turnId: 't'}});
    expect((await next.reconcile()).draftAttachments).toEqual([]); expect(record?.draft).toBe('');
    expect(client.turn).toHaveBeenCalledOnce(); await next.close();
});

it('commits draft consumption atomically with the turn receipt and retains the receipt when saving fails', async () => {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {
        if (record?.pending && !value.pending) throw new Error('draft acknowledgement failed');
        record = structuredClone(value);
    }};
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    await expect(view.send('Task')).rejects.toThrow('draft acknowledgement failed');
    expect(view.snapshot().pending).toBe(true); expect(record?.pending?.operation).toBe('turn');
    await expect(view.send('Task')).rejects.toMatchObject({code: 'EBUSY'}); expect(client.turn).toHaveBeenCalledOnce();
    await view.close();
});

it('rejects invalid attachment drafts before persisting receipts or starting a native turn', async () => {
    const client = peer(), view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, attachments: ['text', 'image']}}, 'p', 's');
    await view.read();
    await expect(view.send('Review', [{kind: 'image', name: 'image.png', mimeType: 'image/png', content: 'http://localhost/private'}])).rejects.toMatchObject({code: 'EINVAL'});
    await expect(view.saveDraft('Review', [{kind: 'text', name: 'notes', content: 'x'.repeat(65537)}])).rejects.toMatchObject({code: 'EINVAL'});
    expect(client.turn).not.toHaveBeenCalled(); expect(view.snapshot().pending).toBe(false); await view.close();
});

it('recovers permanent deletion from the receipt before reading missing history and never replays it', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, delete: true}};
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.delete = vi.fn(async () => {throw {outcome: 'unknown'};});
    const first = new HarnessConversation(client, capable, 'p', 's', true, journal); await first.read();
    await expect(first.delete()).rejects.toMatchObject({outcome: 'unknown'}); await first.close();
    vi.mocked(client.read).mockRejectedValue(new Error('History permanently deleted'));
    vi.mocked(client.operation).mockResolvedValue({requestId: record!.pending!.requestId, outcome: 'committed', result: {deletedSessionIds: ['s', 'child']}});
    const restored = new HarnessConversation(client, capable, 'p', 's', true, journal);
    expect(await restored.read()).toMatchObject({deletedSessionIds: ['s', 'child'], pending: false, canSend: false, canDelete: false, messages: []});
    expect(client.read).toHaveBeenCalledOnce(); expect(client.delete).toHaveBeenCalledOnce();
    expect(record!.deletedSessionIds).toEqual(['s', 'child']); await restored.close();
    const reopened = new HarnessConversation(client, capable, 'p', 's', true, journal);
    expect((await reopened.read()).deletedSessionIds).toEqual(['s', 'child']);
    expect(client.read).toHaveBeenCalledOnce(); await reopened.close();
});
it('deletes only idle owned or archived unloaded sessions with a writable native capability', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, delete: true}};
    client.delete = vi.fn(async () => ({deletedSessionIds: ['s']}));
    for (const state of [{status: 'active', owned: true}, {status: 'notLoaded', owned: false}, {status: 'idle', owned: false}]) {
        vi.mocked(client.read).mockResolvedValue({session: {...session, ...state}, turns: []});
        const view = new HarnessConversation(client, capable, 'p', 's'); await view.read();
        await expect(view.delete()).rejects.toMatchObject({code: 'EACCES'}); await view.close();
    }
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'notLoaded', owned: false, archived: true}, turns: []});
    const readonly = new HarnessConversation(client, capable, 'p', 's', false); await readonly.read();
    await expect(readonly.delete()).rejects.toMatchObject({code: 'EACCES'}); await readonly.close();
    const view = new HarnessConversation(client, capable, 'p', 's'); await view.read();
    expect((await view.delete()).deletedSessionIds).toEqual(['s']); expect(client.resume).not.toHaveBeenCalled(); await view.close();
});

it('archives unloaded native history without acquiring ownership or claiming external inactivity', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, archive: true}};
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'notLoaded', owned: false}, turns: []});
    client.archive = vi.fn(async () => ({session: {...session, status: 'notLoaded', owned: false, archived: true}}));
    const view = new HarnessConversation(client, capable, 'p', 's');
    expect(await view.read()).toMatchObject({canArchive: true, observation: {execution: 'unknown', rawStatus: 'notLoaded'}});
    expect(await view.archive(true)).toMatchObject({archived: true, canSend: false});
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled(); await view.close();
});


it('exposes the committed turn identity even before its native history echo is available', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    const accepted = await view.send('pending echo');
    expect(accepted.submittedTurnId).toBe('t'); expect(client.turn).toHaveBeenCalledOnce();
    expect((await view.read()).submittedTurnId).toBe('t'); await view.close();
});

it('retains input and never starts a turn when another native writer prevents resuming', async () => {
    const client = peer(); vi.mocked(client.read).mockResolvedValue({session: {...session, owned: false}, turns: []});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.resume).mockRejectedValue(Object.assign(new Error('HARNESS_SESSION_BUSY'), {outcome: 'not-committed'}));
    await expect(view.send('keep input')).rejects.toThrow('HARNESS_SESSION_BUSY');
    expect(view.snapshot()).toMatchObject({pending: false, draft: 'keep input', submittedTurnId: undefined});
    expect(client.turn).not.toHaveBeenCalled(); await view.close();
});
