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
            catch { throw new FSError('EIO', 'Invalid file server JSON', 'protocol'); }
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
        let sent = false;
        try {
            checkOperation(scope.options);
            const token = await this.config.credential(); checkOperation(scope.options);
            const headers = new Headers(init.headers); headers.set('Authorization', this.authorization(token));
            if (init.body) headers.set('Content-Type', 'application/json');
            sent = true;
            const response = await this.send(route, { ...init, headers }, scope.options, scope.remaining);
            if (!response.ok) throw await responseError(response);
            return await consume(response);
        } catch (error) {
            const cancelled = error instanceof FSOperationCancelledError ? error : cancellationReason(scope.options);
            if (cancelled) throw stagedCancellation(cancelled, sent);
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
            const body = await boundedBody(response, 1024 * 1024);
            let receipt: { outcome?: string; code?: string; result?: unknown } | undefined;
            try { receipt = JSON.parse(new TextDecoder().decode(body)) as typeof receipt; }
            catch { receipt = undefined; }
            // A readable receipt is evidence: a rejection is not-committed, not unknown. Only an
            // unreadable response leaves the outcome genuinely open.
            if (!receipt) throw new HttpMutationError(statusCode(response.status), operationId, response.status >= 500 ? 'unknown' : 'not-committed');
            if (response.ok && receipt.outcome === 'committed') return receipt.result as T;
            throw new HttpMutationError(remoteCode(receipt.code), operationId, receipt.outcome ?? 'unknown');
        } catch (error) {
            if (error instanceof HttpMutationError) {
                if (error.outcome === 'unknown') this.reconcile(statusRoute, operationId);
                throw error;
            }
            if (!sent) { checkOperation(scope.options); throw error; }
            // A lost response never authorizes replay; only an unknown result is worth reconciling.
            this.reconcile(statusRoute, operationId);
            throw new HttpMutationError(cancellationReason(scope.options)?.timedOut ? 'ETIMEDOUT' : scope.options.signal?.aborted ? 'ECANCELLED' : 'EIO', operationId, 'unknown');
        } finally { scope.dispose(); }
    }
    private reconcile(statusRoute: string, operationId: string): void {
        void this.json(`${statusRoute}/${operationId}/cancel`, { method: 'POST' }, { timeoutMs: 5000 }).catch(() => {});
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

export class HttpResponseError extends FSError {
    constructor(code: FSErrorCode, message: string, readonly status: number) { super(code, message); }
    get httpStatus(): number { return this.status; }
}

async function responseError(response: Response): Promise<FSError> {
    let declared: unknown, message: unknown;
    try {
        const payload = JSON.parse(new TextDecoder().decode(await boundedBody(response, 64 * 1024))) as { code?: unknown; message?: unknown };
        declared = payload.code; message = payload.message;
    } catch { /* an empty body or an HTML proxy response: the status code is the only evidence */ }
    return new HttpResponseError(remoteCode(declared, statusCode(response.status)),
        typeof message === 'string' && message ? message : `File server returned ${response.status}`, response.status);
}

const STATUS_CODES: Record<number, FSErrorCode> = { 400: 'EINVAL', 401: 'EACCES', 403: 'EACCES', 404: 'ENOENT', 409: 'EEXIST',
    412: 'ECONFLICT', 413: 'EINVAL', 416: 'EINVAL', 422: 'ECAPABILITY', 428: 'EINVAL', 429: 'EBUSY', 501: 'ECAPABILITY',
    503: 'EBUSY', 504: 'ETIMEDOUT', 507: 'ENOSPC' };

function statusCode(status: number): FSErrorCode { return STATUS_CODES[status] ?? 'EIO'; }

/** The scope aborts with a cancellation reason; anything else aborted the signal. */
function cancellationReason(options: OperationOptions): FSOperationCancelledError | undefined {
    if (!options.signal?.aborted) return undefined;
    const reason = options.signal.reason;
    return reason instanceof FSOperationCancelledError ? reason : new FSOperationCancelledError();
}

/** A scope cannot know how far work got; once a request is on the wire nothing was committed. */
function stagedCancellation(error: FSOperationCancelledError, sent: boolean): FSOperationCancelledError {
    return !sent || error.outcome !== 'not-started' ? error : new FSOperationCancelledError('not-committed', error.timedOut);
}

async function pause(ms: number, options: OperationOptions): Promise<void> {
    checkOperation(options);
    await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new FSOperationCancelledError()); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, ms);
        options.signal?.addEventListener('abort', abort, { once: true });
    });
}

function remoteCode(value: unknown, fallback: FSErrorCode = 'EIO'): FSErrorCode {
    const known: FSErrorCode[] = ['ECONFLICT', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EROFS', 'EACCES', 'EINVAL', 'ECAPABILITY', 'ECANCELLED', 'ETIMEDOUT', 'EBUSY', 'ENOSPC'];
    return known.includes(value as FSErrorCode) ? value as FSErrorCode : fallback;
}
