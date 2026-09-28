import { checkOperation, FSError, FSOperationCancelledError, operationScope, type OperationOptions, type FSErrorCode } from '@itookit/vfs-core';

export interface HttpConnectionOptions {
    endpoint: string;
    credential: () => string | Promise<string>;
    username?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxReadBytes?: number;
}

export class HttpTransport {
    private readonly endpoint: URL;
    private readonly lifetime = new AbortController();
    constructor(private readonly config: HttpConnectionOptions) {
        if (config.maxReadBytes !== undefined && (!Number.isSafeInteger(config.maxReadBytes) || config.maxReadBytes < 0)) throw new FSError('EINVAL', 'Invalid read limit');
        this.endpoint = new URL(config.endpoint.endsWith('/') ? config.endpoint : config.endpoint + '/');
        if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password
            || this.endpoint.search || this.endpoint.hash) throw new FSError('EINVAL', 'Invalid file server endpoint');
    }
    close() { this.lifetime.abort(new FSOperationCancelledError()); }
    async json<T>(route: string, init: RequestInit = {}, options?: OperationOptions): Promise<T> {
        return this.request(route, init, options, async response => {
            const data = await boundedBody(response, 4 * 1024 * 1024);
            try { return JSON.parse(new TextDecoder().decode(data)) as T; }
            catch { throw new FSError('EIO', 'Invalid file server JSON'); }
        });
    }
    async content(route: string, init: RequestInit, options?: OperationOptions) {
        return this.request(route, init, options, async response => ({
            data: await boundedBody(response, this.config.maxReadBytes ?? 32 * 1024 * 1024),
            revision: response.headers.get('etag') ?? undefined,
            status: response.status, range: response.headers.get('content-range'),
        }));
    }
    private async request<T>(route: string, init: RequestInit, options: OperationOptions | undefined,
        consume: (response: Response) => Promise<T>): Promise<T> {
        const scope = operationScope({ ...options, timeoutMs: options?.timeoutMs ?? this.config.timeoutMs ?? 30_000 }, this.lifetime.signal);
        try {
            checkOperation(scope.options);
            const token = await this.config.credential(); checkOperation(scope.options);
            const headers = new Headers(init.headers); headers.set('Authorization', this.authorization(token));
            if (init.body) headers.set('Content-Type', 'application/json');
            const response = await this.send(route, { ...init, headers }, scope.options, scope.remaining);
            if (!response.ok) throw await responseError(response);
            return await consume(response);
        } catch (error) {
            checkOperation(scope.options);
            if (error instanceof FSError) throw error;
            throw new FSError('EIO', 'File server request failed', 'connect');
        } finally { scope.dispose(); }
    }
    async mutate<T>(route: string, init: RequestInit, statusRoute: string, options?: OperationOptions): Promise<T> {
        const operationId = globalThis.crypto.randomUUID();
        const scope = operationScope({ ...options, timeoutMs: options?.timeoutMs ?? this.config.timeoutMs ?? 30_000 }, this.lifetime.signal);
        let sent = false;
        try {
            checkOperation(scope.options);
            const token = await this.config.credential(); checkOperation(scope.options);
            const headers = new Headers(init.headers);
            headers.set('Authorization', this.authorization(token)); headers.set('X-Operation-Id', operationId);
            headers.set('X-Timeout-Ms', String(Math.max(1, Math.floor(scope.remaining() ?? 30_000))));
            sent = true;
            const response = await (this.config.fetch ?? globalThis.fetch)(new URL(route, this.endpoint), {
                ...init, headers, signal: scope.options.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
            });
            const receipt = JSON.parse(new TextDecoder().decode(await boundedBody(response, 1024 * 1024)));
            if (response.ok && receipt.outcome === 'committed') return receipt.result as T;
            throw new HttpMutationError(remoteCode(receipt.code), operationId, receipt.outcome ?? 'unknown');
        } catch (error) {
            if (error instanceof HttpMutationError) throw error;
            if (!sent) { checkOperation(scope.options); throw error; }
            // A lost response never authorizes replay. Cancellation is best effort; query the ID to reconcile.
            void this.json(`${statusRoute}/${operationId}/cancel`, { method: 'POST' }, { timeoutMs: 5000 }).catch(() => {});
            throw new HttpMutationError(scope.options.signal?.reason instanceof FSOperationCancelledError && scope.options.signal.reason.timedOut ? 'ETIMEDOUT' : scope.options.signal?.aborted ? 'ECANCELLED' : 'EIO', operationId, 'unknown');
        } finally { scope.dispose(); }
    }
    private authorization(secret: string): string {
        if (this.config.username === undefined) return `Bearer ${secret}`;
        if (!this.config.username || /[:\r\n]/.test(this.config.username)) throw new FSError('EINVAL', 'Invalid username');
        const bytes = new TextEncoder().encode(`${this.config.username}:${secret}`);
        return `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`;
    }
    private async send(route: string, init: RequestInit, options: OperationOptions, remaining: () => number | undefined): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            checkOperation(options);
            const headers = new Headers(init.headers), budget = remaining();
            if (budget !== undefined) headers.set('X-Timeout-Ms', String(Math.max(1, Math.floor(budget))));
            const response = await (this.config.fetch ?? globalThis.fetch)(new URL(route, this.endpoint), {
                ...init, headers, signal: options.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
            });
            if (attempt >= 2 || ![429, 502, 503, 504].includes(response.status)) return response;
            await response.body?.cancel();
            const retry = Number(response.headers.get('retry-after'));
            await pause(Number.isFinite(retry) && retry > 0 ? retry * 1000 : (100 * 2 ** attempt + Math.random() * 100), options);
        }
    }
}

export class HttpMutationError extends FSError {
    constructor(code: FSErrorCode, readonly operationId: string, readonly outcome: string) {
        super(code, `Remote mutation ${outcome} (${operationId})`);
    }
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > limit) throw new FSError('EIO', 'File server response limit exceeded');
            chunks.push(value);
        }
        const data = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        return data;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function responseError(response: Response): Promise<FSError> {
    await response.body?.cancel();
    const codes: Record<number, FSErrorCode> = { 400: 'EINVAL', 401: 'EACCES', 403: 'EACCES', 404: 'ENOENT',
        409: 'EEXIST', 412: 'ECONFLICT', 416: 'EINVAL', 422: 'ECAPABILITY', 504: 'ETIMEDOUT' };
    return new FSError(codes[response.status] ?? 'EIO', `File server returned ${response.status}`);
}

async function pause(ms: number, options: OperationOptions): Promise<void> {
    checkOperation(options);
    await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new FSOperationCancelledError()); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, ms);
        options.signal?.addEventListener('abort', abort, { once: true });
    });
}

function remoteCode(value: unknown): FSErrorCode {
    const known: FSErrorCode[] = ['ECONFLICT', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EROFS', 'EACCES', 'EINVAL', 'ECAPABILITY', 'ECANCELLED', 'ETIMEDOUT'];
    return known.includes(value as FSErrorCode) ? value as FSErrorCode : 'EIO';
}
