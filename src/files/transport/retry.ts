/** Only safe reads are replayed; process and mutation POSTs never enter this policy. */
export function retryDelay(method: string, response: Response, attempt: number): number | undefined {
    if (method !== 'GET' || attempt >= 2 || ![429, 502, 503, 504].includes(response.status)) return undefined;
    const retry = Number(response.headers.get('retry-after'));
    return Number.isFinite(retry) && retry > 0
        ? Math.min(retry * 1000, 30_000)
        : 100 * 2 ** attempt + Math.random() * 100;
}
