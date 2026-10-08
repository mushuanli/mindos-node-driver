import { FSError, type FSErrorCode, type OperationOutcome } from '@itookit/vfs-core';
import { boundedBody } from './body';
import { remoteCode, statusCode } from './errors';

export class HttpMutationError extends FSError {
    constructor(code: FSErrorCode, readonly operationId: string, readonly outcome: OperationOutcome) {
        super(code, `Remote mutation ${outcome} (${operationId})`);
    }
}

const outcomes = new Set<unknown>(['not-started', 'not-committed', 'committed', 'partial', 'unknown']);

export async function mutationResult<T>(response: Response, operationId: string): Promise<T> {
    const body = await boundedBody(response, 1024 * 1024);
    let receipt: { outcome?: unknown; code?: unknown; result?: unknown } | undefined;
    try { receipt = JSON.parse(new TextDecoder().decode(body)); } catch { /* Status is the only remaining evidence. */ }
    if (!receipt || typeof receipt !== 'object') {
        // A malformed success or server error cannot prove that the mutation was rejected.
        const rejected = response.status >= 400 && response.status < 500;
        throw new HttpMutationError(statusCode(response.status), operationId, rejected ? 'not-committed' : 'unknown');
    }
    if (response.ok && receipt.outcome === 'committed') return receipt.result as T;
    const outcome = outcomes.has(receipt.outcome) ? receipt.outcome as OperationOutcome : 'unknown';
    throw new HttpMutationError(remoteCode(receipt.code, statusCode(response.status)), operationId, outcome);
}
