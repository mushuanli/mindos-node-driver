import {expect, it, vi} from 'vitest';
import {StatBatch} from '../../src/files/stat-batch';
import type {HttpTransport} from '../../src/files/transport';

const stat = {kind: 'directory', modifiedAt: 1};
function batch(json = vi.fn(async (_route: string, init: RequestInit) => ({results: JSON.parse(String(init.body)).paths.map((_path: string, index: number) => ({stat: {...stat, modifiedAt: index + 1}}))}))) {
    return {reader: new StatBatch({json, defaultTimeoutMs: 30_000} as unknown as HttpTransport, 'stat'), json};
}

it('sends a repeated path once and maps each subscriber to the matching result', async () => {
    const b = batch();
    const result = await Promise.all([b.reader.get('root'), b.reader.get('root/a'), b.reader.get('root'), b.reader.get('root/a')]);
    expect(result).toEqual([stat, {...stat, modifiedAt: 2}, stat, {...stat, modifiedAt: 2}]); expect(b.json).toHaveBeenCalledOnce();
    expect(JSON.parse(String(b.json.mock.calls[0][1].body)).paths).toEqual(['root', 'root/a']);
    await b.reader.get('root'); expect(b.json).toHaveBeenCalledTimes(2);
});

it('keeps another subscriber alive when one subscriber to the same path cancels', async () => {
    let release!: () => void, sharedSignal: AbortSignal | undefined;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const json = vi.fn(async (_route: string, _init: RequestInit, options: {signal: AbortSignal}) => {
        sharedSignal = options.signal; await gate; return {results: [{stat}]};
    });
    const reader = new StatBatch({json, defaultTimeoutMs: 30_000} as unknown as HttpTransport, 'stat');
    const controller = new AbortController();
    const cancelled = reader.get('root', {signal: controller.signal}), surviving = reader.get('root');
    const rejected = expect(cancelled).rejects.toMatchObject({code: 'ECANCELLED'});
    await Promise.resolve(); controller.abort(); await rejected;
    expect(sharedSignal?.aborted).toBe(false); release(); expect(await surviving).toEqual(stat);
    expect(JSON.parse(String(json.mock.calls[0][1].body)).paths).toEqual(['root']);
});

it('cancels the shared request when all subscribers leave', async () => {
    let sharedSignal: AbortSignal | undefined;
    const json = vi.fn(async (_route: string, _init: RequestInit, options: {signal: AbortSignal}) => {
        sharedSignal = options.signal;
        return new Promise<never>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))));
    });
    const reader = new StatBatch({json, defaultTimeoutMs: 30_000} as unknown as HttpTransport, 'stat');
    const a = new AbortController(), b = new AbortController();
    const first = reader.get('root', {signal: a.signal}), second = reader.get('root', {signal: b.signal});
    const rejected = Promise.all([expect(first).rejects.toMatchObject({code: 'ECANCELLED'}), expect(second).rejects.toMatchObject({code: 'ECANCELLED'})]);
    await Promise.resolve(); a.abort(); expect(sharedSignal?.aborted).toBe(false);
    b.abort(); await rejected; expect(sharedSignal?.aborted).toBe(true);
});

it('validates unique-path response length and keeps remote failure distinct from missing', async () => {
    const json = vi.fn(async () => ({results: []}));
    const reader = new StatBatch({json, defaultTimeoutMs: 30_000} as unknown as HttpTransport, 'stat');
    const malformed = await Promise.allSettled([reader.get('root'), reader.get('root')]);
    expect(malformed).toEqual([expect.objectContaining({status: 'rejected', reason: expect.objectContaining({code: 'EIO'})}),
        expect.objectContaining({status: 'rejected', reason: expect.objectContaining({code: 'EIO'})})]);
});
