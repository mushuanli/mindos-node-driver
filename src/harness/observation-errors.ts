export interface HarnessObservationError { stage: string; code: string }

function causes(error: unknown): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    while (error && typeof error === 'object' && result.length < 8 && !result.includes(error as Record<string, unknown>)) {
        result.push(error as Record<string, unknown>);
        error = (error as {cause?: unknown}).cause;
    }
    return result;
}

/** A failed request or malformed payload alone does not prove a lost connection. */
export function connectionLost(error: unknown): boolean {
    return causes(error).some(cause =>
        /^(ECONNREFUSED|ECONNRESET|EPIPE|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|CONNECTION_CLOSED|UND_ERR_SOCKET)$/.test(String(cause.code))
        || cause.name === 'TypeError' && /^(fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.?)$/i.test(String(cause.message)));
}

/** Emit only bounded identity and error codes, never response bodies or credentials. */
export class ObservationErrors {
    private readonly reported = new Map<string, string>();
    constructor(private readonly profileId?: string, private readonly sessionId?: string) {}

    record(stage: string, error: unknown): HarnessObservationError {
        const values = causes(error).flatMap(cause => [cause.remoteCode, cause.code]);
        const code = values.find(value => typeof value === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/.test(value)) as string | undefined;
        const failure = {stage, code: code ?? 'OBSERVATION_ERROR'};
        if (this.reported.get(stage) !== failure.code) {
            this.reported.set(stage, failure.code);
            console.warn('[Harness] Observation failed', {profileId: this.profileId, sessionId: this.sessionId, ...failure});
        }
        return failure;
    }

    clear(stage: string): void { this.reported.delete(stage); }
}
