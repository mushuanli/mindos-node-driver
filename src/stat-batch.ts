import { validateStat } from './protocol/stat';
import { checkOperation, FSOperationCancelledError, FSError, operationScope, type FileStat, type OperationOptions } from '@itookit/vfs-core';
import type { HttpTransport } from './transport';

interface Pending {
    path: string; active: boolean; signal: AbortSignal;
    remaining(): number | undefined;
    resolve(value: FileStat | null): void; reject(error: unknown): void;
    finish(): void;
}

export class StatBatch {
    private pending: Pending[] = [];
    constructor(private readonly http: HttpTransport, private readonly route: string) {}
    get(path: string, options?: OperationOptions): Promise<FileStat | null> {
        const scope = operationScope(options);
        try { checkOperation(scope.options); } catch (e) { scope.dispose(); return Promise.reject(e); }
        return new Promise((resolve, reject) => {
            const item: Pending = { path, active: true, signal: scope.options.signal, remaining: scope.remaining,
                resolve, reject, finish: () => { item.active = false; scope.dispose(); item.signal.removeEventListener('abort', abort); } };
            const abort = () => { item.finish(); reject(item.signal.reason instanceof FSError ? item.signal.reason : new FSOperationCancelledError()); };
            item.signal.addEventListener('abort', abort, { once: true });
            this.pending.push(item);
            if (this.pending.length === 1) queueMicrotask(() => { void this.flush(); });
        });
    }
    private async flush(): Promise<void> {
        const pending = this.pending; this.pending = [];
        let items: Pending[] = [], bytes = 0;
        for (const item of pending) {
            if (!item.active) continue;
            const size = new TextEncoder().encode(item.path).length;
            if (items.length >= 256 || bytes + size > 64 * 1024) { void this.send(items); items = []; bytes = 0; }
            items.push(item); bytes += size;
        }
        if (items.length) void this.send(items);
    }
    private async send(items: Pending[]): Promise<void> {
        const controller = new AbortController();
        const changed = () => { if (items.every(item => !item.active)) controller.abort(); };
        for (const item of items) item.signal.addEventListener('abort', changed);
        try {
            // Each subscriber owns its deadline. A short wait must not abort longer waits.
            const budgets = items.filter(item => item.active).map(item => item.remaining() ?? this.http.defaultTimeoutMs);
            const options = { signal: controller.signal, timeoutMs: Math.max(...budgets) };
            const result = await this.http.json<{ results: Array<{ stat?: FileStat | null; error?: string }> }>(this.route,
                { method: 'POST', body: JSON.stringify({ paths: items.map(item => item.path) }) }, options);
            if (!result || !Array.isArray(result.results) || result.results.length !== items.length
                || result.results.some(value => !value || typeof value !== 'object')) throw new FSError('EIO', 'Invalid stat batch response');
            result.results.forEach((value, index) => {
                const item = items[index]; if (!item.active) return;
                if (value.error) item.reject(new FSError((['EACCES', 'EINVAL', 'ENOTDIR', 'ECAPABILITY'].includes(value.error) ? value.error : 'EIO') as import('@itookit/vfs-core').FSErrorCode, 'Remote stat failed'));
                else { validateStat(value.stat); item.resolve(value.stat ?? null); }
            });
        } catch (error) { for (const item of items) if (item.active) item.reject(error); }
        finally { for (const item of items) { item.signal.removeEventListener('abort', changed); item.finish(); } }
    }
}
