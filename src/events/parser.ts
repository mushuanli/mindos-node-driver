import { FSError } from '@itookit/vfs-core';

/** Read bounded UTF-8 SSE frames, including CRLF and chunks split inside a code point. */
export async function readEventStream(body: ReadableStream<Uint8Array>, controller: AbortController,
    accept: (value: unknown) => void): Promise<void> {
    const reader = body.getReader(), decoder = new TextDecoder('utf-8', {fatal:true});
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancel, {once:true});
    let buffer = '', idle: ReturnType<typeof setTimeout> | undefined;
    try {
        while (!controller.signal.aborted) {
            idle = setTimeout(() => controller.abort(),45_000);
            const chunk = await reader.read(); clearTimeout(idle);
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, {stream:true});
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const frame = buffer.slice(0,match.index); buffer = buffer.slice(match.index+match[0].length);
                if (frame.length > 8*1024*1024) throw new FSError('EFBIG','Node event frame limit','protocol');
                const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /,'')).join('\n');
                if (data) accept(JSON.parse(data));
            }
            if (buffer.length > 8*1024*1024) throw new FSError('EFBIG','Node event frame limit','protocol');
        }
    } finally { clearTimeout(idle); controller.signal.removeEventListener('abort',cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
