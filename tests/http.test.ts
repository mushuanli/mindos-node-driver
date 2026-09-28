import { describe, it, expect } from 'vitest';
import { HttpFSBackend, openHttpFileSource } from '../src';

const config = { endpoint: 'https://files.example/', alias: 'docs', credential: () => 'secret' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('HTTP driver', () => {
    it('carries the read revision through a file handle and never replays a failed write', async () => {
        let revision = '"epoch:1"', writes = 0;
        const fetch: typeof globalThis.fetch = async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/exports')) return json({ version: 1, exports: [{ alias: 'docs', access: 'rw', strongRevision: true }] });
            if (path.endsWith('/stat')) return json({ results: JSON.parse(String(init?.body)).paths.map((p: string) => ({ stat: { kind: p ? 'file' : 'directory', revision } })) });
            if (init?.method === 'PUT') {
                writes++;
                expect(new Headers(init.headers).get('if-match')).toBe('"epoch:1"');
                return new Response(JSON.stringify({ outcome: 'not-committed', code: 'ECONFLICT' }), { status: 412 });
            }
            return new Response('old content', { headers: { etag: revision } });
        };
        const owner = await openHttpFileSource({ ...config, fetch });
        const { createFile } = await import('@itookit/vfs-core');
        const file = createFile(owner.fs, '/note');
        await file.read(); revision = '"epoch:2"';
        await expect(file.write('new')).rejects.toMatchObject({ code: 'ECONFLICT', outcome: 'not-committed' });
        expect(writes).toBe(1); await owner.dispose();
    });
    it('reports unknown with an operation ID when a write response is lost', async () => {
        let writes = 0;
        const backend = new HttpFSBackend({ ...config, fetch: async (input, init) => {
            if (String(input).endsWith('/exports')) return json({ version: 1, exports: [{ alias: 'docs', access: 'rw', strongRevision: true }] });
            if (init?.method === 'PUT') { writes++; throw new TypeError('connection lost'); }
            return json({ outcome: 'committed' });
        } });
        await backend.init();
        await expect(backend.mutations!.replace('note', new Uint8Array(), { kind: 'match', revision: '"old"' }))
            .rejects.toMatchObject({ outcome: 'unknown', operationId: expect.any(String) });
        expect(writes).toBe(1); await backend.close();
    });
    it('batches prefix stats and keeps a cancelled subscriber isolated', async () => {
        const bodies: unknown[] = []; let unblock!: () => void;
        const fetch: typeof globalThis.fetch = async (_url, init) => {
            bodies.push(JSON.parse(String(init!.body)));
            await new Promise<void>(resolve => { unblock = resolve; });
            expect(init!.signal!.aborted).toBe(false);
            return json({ results: [{ stat: { kind: 'directory' } }, { stat: { kind: 'file', size: 4 } }] });
        };
        const backend = new HttpFSBackend({ ...config, fetch });
        const controller = new AbortController();
        const a = expect(backend.files.stat('a', { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELLED' });
        const b = backend.files.stat('a/b');
        await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); unblock();
        await a; expect((await b)?.kind).toBe('file'); expect(bodies).toEqual([{ paths: ['a', 'a/b'] }]);
        await backend.close();
    });
    it('authenticates without putting credentials in URLs and returns binary content', async () => {
        const fetch: typeof globalThis.fetch = async (input, init) => {
            expect(String(input)).not.toContain('secret'); expect(init?.redirect).toBe('error');
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/exports')) return json({ version: 1, exports: [{ alias: 'docs', access: 'ro' }] });
            if (path.endsWith('/stat')) return json({ results: JSON.parse(String(init?.body)).paths.map((p: string) => ({ stat: { kind: p ? 'file' : 'directory' } })) });
            return new Response(new Uint8Array([0, 255, 128]));
        };
        const owner = await openHttpFileSource({ ...config, fetch });
        const data = await owner.fs.driver.readContent('/file', { encoding: 'binary' });
        expect([...new Uint8Array(data)]).toEqual([0, 255, 128]);
        await expect(owner.fs.driver.writeContent('/file', 'x')).rejects.toMatchObject({ code: 'EROFS' });
        await owner.dispose();
    });
    it('rejects path traversal, fake range responses and missing permissions', async () => {
        const backend = new HttpFSBackend({ ...config, fetch: async () => new Response('wrong', { status: 200 }) });
        expect(() => backend.files.stat('../escape')).toThrow();
        await expect(backend.files.read('file', { offset: 2, length: 3 })).rejects.toMatchObject({ code: 'EIO' });
        const denied = new HttpFSBackend({ ...config, fetch: async () => new Response('', { status: 403 }) });
        await expect(denied.files.stat('file')).rejects.toMatchObject({ code: 'EACCES' });
        await backend.close(); await denied.close();
    });
});

it('uses UTF-8 Basic credentials for named user/password connections', async () => {
    let authorization = '';
    const backend = new HttpFSBackend({ ...config, username: 'alice', credential: () => 'päss:word', fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization')!;
        return json({ version: 1, exports: [{ alias: 'docs', access: 'ro' }] });
    } });
    await backend.init();
    expect(authorization).toBe('Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode('alice:päss:word'))));
    await backend.close();
});
