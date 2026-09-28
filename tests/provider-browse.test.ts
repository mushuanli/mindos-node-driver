import { it, expect, vi } from 'vitest';
import { createHttpSourceProvider } from '../src/provider';

it('keeps stored passwords during draft checks and pages only directory entries', async () => {
    const seen: { url: URL; auth: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
        const url = new URL(String(input)); seen.push({ url, auth: new Headers(init.headers).get('Authorization') });
        const body = url.pathname.endsWith('/exports') ? { version: 1, exports: [{ alias: 'docs' }] }
            : { entries: [{ name: 'nested', stat: { kind: 'directory' } }, { name: 'note', stat: { kind: 'file', size: 3 } }], nextCursor: 'next' };
        return new Response(JSON.stringify(body));
    }));
    const provider = createHttpSourceProvider();
    const connection = { endpoint: 'https://files.test', username: 'user', credentialRef: 'key' };
    provider.setCredential('key', 'previous');
    try {
        await provider.checkDraft(connection, 'draft');
        await provider.checkDraft(connection, '');
        expect(seen.map(item => item.auth)).toEqual(['Basic ' + btoa('user:draft'), 'Basic ' + btoa('user:previous')]);
        expect(await provider.browse(connection, '/')).toEqual({ paths: ['/docs'], nextCursor: null });
        expect(await provider.browse(connection, '/docs/a', 'cursor')).toEqual({ paths: ['/docs/a/nested'], nextCursor: 'next' });
        expect(seen.at(-1)!.url.searchParams.get('cursor')).toBe('cursor');
        expect(seen.at(-1)!.url.searchParams.get('path')).toBe('a');
        expect(seen.at(-1)!.auth).toBe('Basic ' + btoa('user:previous'));
    } finally { await provider.dispose(); vi.unstubAllGlobals(); }
});

it.each([401, 403, 404, 500])('preserves HTTP %i during a connection check', async httpStatus => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream failure', { status: httpStatus })));
    const provider = createHttpSourceProvider();
    try {
        await expect(provider.checkDraft({ endpoint: 'https://files.test', username: 'user', credentialRef: 'key' }, 'secret'))
            .rejects.toMatchObject({ httpStatus });
    } finally { await provider.dispose(); vi.unstubAllGlobals(); }
});

it('distinguishes unavailable credentials, unreachable servers and malformed protocol responses', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')); vi.stubGlobal('fetch', fetch);
    const provider = createHttpSourceProvider(), connection = { endpoint: 'https://files.test', username: 'user', credentialRef: 'key' };
    try {
        await expect(provider.checkDraft(connection, '')).rejects.toMatchObject({ operation: 'credential' });
        expect(fetch).not.toHaveBeenCalled();
        await expect(provider.checkDraft(connection, 'secret')).rejects.toMatchObject({ operation: 'connect' });
        fetch.mockResolvedValue(new Response('<html>login</html>'));
        await expect(provider.checkDraft(connection, 'secret')).rejects.toMatchObject({ operation: 'protocol' });
    } finally { await provider.dispose(); vi.unstubAllGlobals(); }
});
