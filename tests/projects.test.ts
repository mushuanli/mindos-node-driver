import { expect, it, vi } from 'vitest';
import { MCPProjectClient } from '../src/projects';
const project = {id:'p',name:'Notes',alias:'home',path:'group/notes',access:'rw' as const,revision:2,mounts:[]};
it('shares the project revision with harness operations and restricts available workspaces',async () => {
    const call=vi.fn(async (name: string,args: Record<string,unknown>) => {
        if (name==='harness_profiles') return {epoch:'e',profiles:[
            {id:'codex',kind:'codex',projectRuntime:true,workspaces:[],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}},
            {id:'legacy',kind:'codex',workspaces:[{id:'host'}],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}}]};
        if (name==='harness_sessions') return {sessions:[],nextCursor:null};
        if (name==='harness_resume') return {outcome:'not-committed',requestId:args.requestId,code:'EACCES'};
        return {project};
    });
    const client=new MCPProjectClient({call,close:vi.fn()});
    expect(await client.register({name:'Notes',alias:'home',path:'group/notes',access:'rw'})).toEqual(project);
    const harness=client.harness(project);
    expect((await harness.profiles()).profiles.map(p=>[p.id,p.workspaces])).toEqual([['codex',[{id:'p'}]]]);
    await harness.list('codex');
    expect(call).toHaveBeenLastCalledWith('harness_sessions',{projectId:'p',revision:2,profileId:'codex'},undefined);
    await expect(harness.resume('codex','foreign')).rejects.toMatchObject({outcome:'not-committed',code:'EACCES'});
    expect(call.mock.calls.at(-1)?.[1]).toMatchObject({projectId:'p',revision:2,epoch:'e'});
});
it('rejects incomplete directory project responses before exposing them to callers',async () => {
    const client=new MCPProjectClient({call:async()=>({project:{...project,revision:0}}),close:vi.fn()});
    await expect(client.read('p')).rejects.toThrow('Invalid project descriptor');
});
