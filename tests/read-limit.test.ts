import { it, expect, vi } from 'vitest';
import { HttpTransport } from '../src/transport';

it.each([true, false])('rejects oversized bodies with EFBIG and cancels them (Content-Length=%s)', async declared => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel });
    const http = new HttpTransport({ endpoint: 'https://files.test', credential: () => 'secret', maxReadBytes: 8,
        fetch: async () => new Response(body, { headers: declared ? { 'Content-Length': '9' } : {} }) });
    try {
        await expect(http.content('v1/fs/docs/content', {})).rejects.toMatchObject({ code: 'EFBIG', operation: 'read' });
        expect(cancel).toHaveBeenCalledOnce();
    } finally { http.close(); }
});
