import type { OperationOptions } from '@itookit/vfs-core';
import type { HttpTransport } from '../transport';
import type { ProcessStatus, RemoteProcessSpec } from './contracts';
import { validateStatus } from './protocol';

/** Wire protocol only: retries and process ownership belong to separate layers. */
export class ProcessClient {
    constructor(private readonly http: HttpTransport, private readonly spec: RemoteProcessSpec) {}

    start(id: string, command: string, args: string[], cwd: string, timeoutMs: number, options: OperationOptions) {
        return this.request('v1/processes', { method: 'POST', body: JSON.stringify({
            ...this.spec, requestId: id, command, args, cwd, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        }) }, options);
    }

    status(id: string, options?: OperationOptions) { return this.request(this.route(id), {}, options); }
    cancel(id: string) { return this.request(`${this.route(id)}/cancel`, { method: 'POST' }, { timeoutMs: 5000 }); }
    close() { this.http.close(); }

    private route(id: string) { return `v1/processes/${encodeURIComponent(this.spec.epoch)}/${encodeURIComponent(id)}`; }
    private async request(route: string, init: RequestInit, options?: OperationOptions): Promise<ProcessStatus> {
        const status = await this.http.json<ProcessStatus>(route, init, options);
        validateStatus(status);
        return status;
    }
}
