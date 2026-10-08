import { Client, StreamableHTTPClientTransport, isCallToolResult } from '@modelcontextprotocol/client';
import { FSError, checkOperation, operationScope, type OperationOptions } from '@itookit/vfs-core';

export interface HarnessRpc {
    call(name: string, args: object, options?: OperationOptions): Promise<unknown>;
    metadata?(options?: OperationOptions): Promise<Record<string, unknown> | undefined>;
    close(): Promise<void>;
}

export function createHarnessRpc(endpoint: string, fetch: typeof globalThis.fetch, exactEndpoint = false): HarnessRpc {
    const client = new Client({ name: 'itookit-piagent-driver', version: '0.1.0' }, {
        supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
        inputRequired: { autoFulfill: false },
    });
    const lifetime = new AbortController();
    let connecting: Promise<void> | undefined;
    const connect = () => connecting ??= client.connect(new StreamableHTTPClientTransport(exactEndpoint ? new URL(endpoint)
        : new URL('mcp',endpoint.endsWith('/') ? endpoint : endpoint + '/'),{fetch}),{timeout:30_000})
        .catch(async error => {connecting = undefined;await client.close();throw error;});
    const invoke = async <T>(options: OperationOptions | undefined, run: (scope: ReturnType<typeof operationScope>) => Promise<T>): Promise<T> => {
        const scope = operationScope({...options,timeoutMs:options?.timeoutMs ?? 30_000},lifetime.signal);
        try {
            checkOperation(scope.options);await waitFor(connect(),scope.options.signal);checkOperation(scope.options);
            return await run(scope);
        } finally {scope.dispose();}
    };
    return {
        call:(name,args,options) => invoke(options,scope => callHarnessTool(client,name,args,scope)),
        metadata:options => invoke(options,async () => client.getDiscoverResult()?._meta),
        async close() { lifetime.abort(); await client.close(); },
    };
}
async function callHarnessTool(client: Client, name: string, args: object, scope: ReturnType<typeof operationScope>): Promise<unknown> {
    const result = await client.callTool({name,arguments:{...args}},{signal:scope.options.signal,timeout:scope.remaining()});
    if (!isCallToolResult(result)) throw new FSError('EIO','Invalid harness result');
    if (result.isError) {
        const content=(result as {structuredContent?:{code?: string;outcome?: string}}).structuredContent;
        const code=content?.code;
        throw Object.assign(new FSError('EIO',code ?? 'Harness RPC failed'),{remoteCode:code,outcome:content?.outcome==='unknown'?'unknown':'not-committed'});
    }
    return result.structuredContent;
}

function waitFor(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return pending;
    return new Promise((resolve,reject) => {
        const abort = () => { cleanup(); try { checkOperation({signal}); } catch (error) { reject(error); } };
        const cleanup = () => signal.removeEventListener('abort',abort);
        signal.addEventListener('abort',abort,{ once:true });
        if (signal.aborted) abort();
        void pending.then(() => { cleanup(); resolve(); },error => { cleanup(); reject(error); });
    });
}
