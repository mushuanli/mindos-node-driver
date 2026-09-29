import { FSError } from '@itookit/vfs-core';

export async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if ((!encoding || encoding === 'identity') && declared && /^\d+$/.test(declared) && Number(declared) > limit) {
        await response.body?.cancel().catch(() => {});
        throw new FSError('EFBIG', `File server response exceeds ${limit} bytes`, 'read');
    }
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > limit) throw new FSError('EFBIG', `File server response exceeds ${limit} bytes`, 'read');
            chunks.push(value);
        }
        const data = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        return data;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
