import { it,expect,vi } from 'vitest';
import { MCPProjectClient } from '../src/projects';
it('preserves directory failure codes and unknown outcomes without replaying the plan',async()=>{
    const call=vi.fn(async()=>{throw {remoteCode:'SYNC_CONFLICT',outcome:'unknown',message:'conflict'};});
    const client=new MCPProjectClient({call,close:vi.fn()}).directorySync();
    await expect(client.execute('binding','plan')).rejects.toMatchObject({code:'SYNC_CONFLICT',outcome:'unknown'});
    expect(call).toHaveBeenCalledTimes(1);expect(call).toHaveBeenCalledWith('project_sync_execute',{bindingId:'binding',planId:'plan'},undefined);
});
it('rejects malformed plans before offering execution',async()=>{
    const client=new MCPProjectClient({call:async()=>({plan:{id:'p',state:'ready',actions:[],conflicts:[]}}),close:vi.fn()}).directorySync();
    await expect(client.preview('binding')).rejects.toThrow('Invalid directory synchronization response');
});
it('passes direction changes, conflict decisions and comparison identities without automatic execution',async()=>{
    const plan={id:'plan',manifestHash:'hash',generation:'1',state:'ready',direction:'both',actions:[],conflicts:[],accepted:{},conflictDetails:[]};
    const binding={id:'binding',projectId:'p',revision:1,syncProjectId:'s',datasetId:'files',historyEpoch:'e',target:'sub',direction:'both',policyRevision:2,baseline:{},plan};
    const call=vi.fn(async(name:string)=>name==='project_sync_configure'?{binding}:name==='project_sync_resolve'?{plan}:{path:'note',baseline:{kind:'missing'},dataset:{kind:'file',content:{text:'dataset'}},directory:{kind:'file',content:{text:'directory'}}});
    const client=new MCPProjectClient({call,close:vi.fn()}).directorySync();
    await client.configure('binding',1,'both');await client.resolve('binding','old',{'note':'directory'});expect((await client.compare('binding','plan','note')).directory.content?.text).toBe('directory');
    expect(call).toHaveBeenNthCalledWith(1,'project_sync_configure',{bindingId:'binding',policyRevision:1,direction:'both'},undefined);
    expect(call).toHaveBeenNthCalledWith(2,'project_sync_resolve',{bindingId:'binding',planId:'old',decisions:{note:'directory'}},undefined);
    expect(call).toHaveBeenCalledTimes(3);
});
it('rejects unsafe directory responses and oversized content previews',async()=>{
    const call=vi.fn(async()=>({paths:['../escape']} as unknown));const client=new MCPProjectClient({call,close:vi.fn()}).directorySync();
    await expect(client.directories('p',1,'')).rejects.toThrow('Invalid directory synchronization response');
    call.mockResolvedValue({path:'note',baseline:{kind:'missing'},dataset:{kind:'file',content:{text:'x'.repeat(256*1024+1)}},directory:{kind:'missing'}});
    await expect(client.compare('binding','plan','note')).rejects.toThrow('Invalid directory synchronization response');
});
