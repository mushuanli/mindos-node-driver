import { expect, it, vi } from 'vitest';
import type { FileSystemSourceOwner } from '@itookit/vfs-core';
import { SourcePool } from '../src/provider/source-pool';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function source() { return { fs: {} as FileSystemSourceOwner['fs'], dispose: vi.fn(async () => {}) }; }

it('isolates a cancelled initializer subscriber and disposes once after the last release', async () => {
    const pool = new SourcePool(), pending = deferred<FileSystemSourceOwner>(), owner = source();
    let signal!: AbortSignal;
    const open = vi.fn((value: AbortSignal) => { signal = value; return pending.promise; });
    const controller = new AbortController();
    const a = expect(pool.acquire('key', open, { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELLED' });
    const b = pool.acquire('key', open);
    await Promise.resolve(); controller.abort(); await a;
    expect(signal.aborted).toBe(false);
    pending.resolve(owner);
    const lease = await b;
    expect(open).toHaveBeenCalledTimes(1);
    await lease.dispose(); await lease.dispose(); await pool.dispose();
    expect(owner.dispose).toHaveBeenCalledTimes(1);
});

it('cancels unowned initialization without blocking its subscriber and closes late results', async () => {
    const pool = new SourcePool(), pending = deferred<FileSystemSourceOwner>(), owner = source();
    const controller = new AbortController(); let signal!: AbortSignal;
    const waiting = expect(pool.acquire('key', value => { signal = value; return pending.promise; }, { signal: controller.signal }))
        .rejects.toMatchObject({ code: 'ECANCELLED' });
    await Promise.resolve(); controller.abort(); await waiting;
    expect(signal.aborted).toBe(true);
    pending.resolve(owner);
    await vi.waitFor(() => expect(owner.dispose).toHaveBeenCalledTimes(1));
    await pool.dispose();
});

it('retries a failed initialization and closes active leases once on provider disposal', async () => {
    const pool = new SourcePool(), owner = source();
    await expect(pool.acquire('key', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    const lease = await pool.acquire('key', async () => owner);
    await pool.dispose(); await lease.dispose();
    expect(owner.dispose).toHaveBeenCalledTimes(1);
    await expect(pool.acquire('key', async () => owner)).rejects.toMatchObject({ code: 'EACCES' });
});
