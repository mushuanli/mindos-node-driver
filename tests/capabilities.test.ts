import { describe, it, expect } from 'vitest';
import { HttpTransport } from '../src/transport';
import { discoverServer } from '../src/capabilities';
const caps = { version: 1, serverId: 'node-a', files: { read: true, write: false }, sync: { push: false },
    process: { exec: false }, terminal: { pty: false }, executionModel: 'none', workspaceConsistency: 'none',
    readOnlyEnforcement: 'none', pathModel: 'none' };
function transport(fetch: typeof globalThis.fetch) { return new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch }); }
describe('remote support discovery', () => {
    it('authenticates and validates support independently of execution permission', async () => {
        const client = transport(async (_url, init) => {
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
            return Response.json(caps);
        });
        expect(await discoverServer(client)).toEqual(caps); client.close();
    });
    it('falls back only on a missing capability route and authenticates legacy exports', async () => {
        const calls: string[] = [];
        const client = transport(async url => {
            calls.push(String(url));
            return String(url).endsWith('capabilities') ? new Response('', { status: 404 }) : Response.json({ version: 1, exports: [{ access: 'rw' }] });
        });
        expect(await discoverServer(client)).toMatchObject({ serverId: null, process: { exec: false }, files: { write: true } });
        expect(calls).toHaveLength(2); client.close();
    });
    it.each([401, 403, 500])('does not downgrade HTTP %s to files-only', async status => {
        const client = transport(async () => new Response('', { status }));
        await expect(discoverServer(client)).rejects.toMatchObject({ httpStatus: status }); client.close();
    });
    it('rejects a claimed executable node without an identity', async () => {
        const client = transport(async () => Response.json({ ...caps, process: { exec: true } }));
        await expect(discoverServer(client)).rejects.toMatchObject({ code: 'EIO' }); client.close();
    });
});
