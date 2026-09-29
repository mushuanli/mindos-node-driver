import { expect, it, vi } from 'vitest';
import { HttpTransport } from '../src/transport';
import { HttpProcessSession } from '../src/process';
const spec = { serverId: 'node', epoch: 'epoch', cwd: '/workspace', mounts: [{ alias: 'code', path: '', at: '/workspace', access: 'rw' as const }] };
const status = (state = 'exited') => ({ state, stdout: 'output', stderr: '', code: 0, error: null, truncated: false });
it('uses canonical cwd and the frozen mounts without replaying process creation', async () => {
    const fetch = vi.fn(async (_url, init) => {
        expect(init.redirect).toBe('error');
        const input = JSON.parse(init.body);
        expect(Number.isInteger(input.timeoutMs)).toBe(true);
        expect(input).toMatchObject({ ...spec, cwd: '/workspace/sub', command: 'bash', args: ['-c', 'pwd'] });
        return Response.json(status());
    });
    const owner = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch }), spec);
    expect(await owner.nativeShell.exec('bash', ['-c', 'pwd'], { cwd: 'sub' })).toEqual({ stdout: 'output', stderr: '', code: 0 });
    expect(fetch).toHaveBeenCalledTimes(1); await owner.release();
});
it('never retries a POST on 503 and fences an unknown startup with cancel', async () => {
    const paths: string[] = [];
    const owner = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch: async url => {
        const path = String(url); paths.push(path);
        return path.endsWith('/cancel') ? Response.json(status('cancelled')) : Response.json({ code: 'EBUSY' }, { status: 503 });
    } }), spec);
    await expect(owner.nativeShell.exec('bash', ['-c', 'touch x'])).rejects.toThrow();
    expect(paths.filter(path => path.endsWith('/processes'))).toHaveLength(1);
    expect(paths.some(path => path.endsWith('/cancel'))).toBe(true); await owner.release();
});
it('does not release an owner until cancellation is confirmed', async () => {
    let reachable = false;
    const owner = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch: async () => {
        if (!reachable) throw new Error('offline'); return Response.json(status('cancelled'));
    } }), spec);
    await expect(owner.nativeShell.exec('bash', ['-c', 'sleep 20'])).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(owner.release()).rejects.toThrow(); reachable = true; await owner.release();
    await expect(owner.nativeShell.exec('bash', ['-c', 'true'])).rejects.toThrow('closed');
});

it('snapshots mounts instead of retaining mutable caller authorization', async () => {
    const input = structuredClone(spec);
    const fetch = vi.fn(async (_url, init) => {
        expect(JSON.parse(String(init?.body)).mounts[0].alias).toBe('code');
        return Response.json(status());
    });
    const owner = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch }), input);
    input.mounts[0].alias = 'other';
    await owner.nativeShell.exec('bash', ['-c', 'pwd']); await owner.release();
});

it('rejects an already expired execution without contacting the server', async () => {
    const fetch = vi.fn();
    const owner = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch }), spec);
    await expect(owner.nativeShell.exec('bash', [], { timeoutMs: 0 })).rejects.toMatchObject({ code: 'ETIMEDOUT', outcome: 'not-started' });
    expect(fetch).not.toHaveBeenCalled(); await owner.release();
});

it('keeps a malformed cleanup status outstanding until a valid terminal status arrives', async () => {
    let reachable = false;
    const owner = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch: async () =>
        Response.json(reachable ? status('cancelled') : { ...status('cancelled'), error: 12 }) }), spec);
    await expect(owner.nativeShell.exec('bash', [])).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(owner.release()).rejects.toThrow('Invalid remote process status');
    reachable = true; await owner.release();
});

it('applies one execution deadline and confirms cancellation with an independent cleanup budget', async () => {
    const paths: string[] = [];
    const owner = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch: async url => {
        paths.push(String(url));
        return Response.json(status(String(url).endsWith('/cancel') ? 'cancelled' : 'running'));
    } }), spec);
    await expect(owner.nativeShell.exec('bash', ['-c', 'sleep 10'], { timeoutMs: 20 }))
        .rejects.toMatchObject({ code: 'ETIMEDOUT', outcome: 'partial' });
    expect(paths.filter(path => path.endsWith('/processes'))).toHaveLength(1);
    expect(paths.some(path => path.endsWith('/cancel'))).toBe(true);
    await owner.release();
});
