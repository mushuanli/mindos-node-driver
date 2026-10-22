import { FSError, checkOperation, operationScope, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessEvents } from './contracts';
import type { HarnessRpc } from './rpc';
import { validateEvents } from './validation';
import { requestId } from '../files/request-id';

/** Bounded local replay lets independent views share one remote profile subscription. */
export class HarnessEventFeed {
    private page?: HarnessEvents;
    private failure?: unknown;
    private retainedAfter = 0;
    private readonly listeners = new Set<() => void>();
    private readonly waiters = new Set<() => void>();
    private readonly stop: () => void;
    constructor(rpc: HarnessRpc, args: Record<string, unknown>) {
        this.stop = rpc.subscribe('harness', args, {next: value => this.accept(validateEvents(value)), error: error => {
            this.failure = error; this.notify();
        }});
    }
    private accept(next: HarnessEvents): void {
        const prior = this.page;
        if (prior?.epoch === next.epoch && next.cursor < prior.cursor) return;
        if (!prior || prior.epoch !== next.epoch || next.gap) this.retainedAfter = next.after ?? Math.max(0,(next.events[0]?.seq ?? 1)-1);
        const indexed = new Map((prior?.epoch === next.epoch && !next.gap ? prior.events : []).map(row => [row.seq,row]));
        for (const row of next.events) indexed.set(row.seq,row);
        const events = [...indexed.values()];
        let bytes = events.reduce((sum,row) => sum + JSON.stringify(row).length,0);
        while (events.length > 1024 || bytes > 8*1024*1024) {
            const removed = events.shift()!; this.retainedAfter = removed.seq; bytes -= JSON.stringify(removed).length;
        }
        this.page = {...next, events}; this.failure = undefined; this.notify();
    }
    private notify(): void {
        for (const listener of [...this.waiters, ...this.listeners]) {
            const started = Date.now();
            try { listener(); }
            catch { console.warn('[Harness] Event observer failed', { operation: 'harness.events.observe', operationId: requestId(),
                stage: 'notify', outcome: 'failure', code: 'EVENT_OBSERVER_FAILED', durationMs: Date.now() - started }); }
        }
    }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async snapshot(cursor?: {after:number;eventEpoch:string}, options?: OperationOptions): Promise<HarnessEvents> {
        const scope = operationScope({...options,timeoutMs:options?.timeoutMs ?? 30_000});
        try {
            if (!this.page && !this.failure) await this.wait(scope.options.signal);
            checkOperation(scope.options); if (this.failure) throw this.failure;
            const page = this.page!;
            const reset = !!cursor && (cursor.eventEpoch !== page.epoch || cursor.after > page.cursor);
            return {...page, gap: reset || (cursor ? cursor.after < this.retainedAfter : page.gap),
                events:page.events.filter(row => reset || !cursor || row.seq > cursor.after)};
        } finally { scope.dispose(); }
    }
    private wait(signal?: AbortSignal): Promise<void> {
        return new Promise((resolve,reject) => {
            const cleanup = () => { this.waiters.delete(done); signal?.removeEventListener('abort',abort); };
            const done = () => { cleanup(); resolve(); }, abort = () => { cleanup(); reject(new FSError('ECANCELLED','Event observation cancelled')); };
            this.waiters.add(done); signal?.addEventListener('abort',abort,{once:true});
            if (signal?.aborted) abort();
        });
    }
    close(): void { this.stop(); this.failure = new FSError('ECANCELLED','Event observation closed'); this.notify(); this.listeners.clear(); }
}
