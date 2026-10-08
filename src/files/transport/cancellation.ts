import { checkOperation, FSOperationCancelledError, type OperationOptions } from '@itookit/vfs-core';

/** The scope aborts with a cancellation reason; anything else aborted the signal. */
export function cancellationReason(options: OperationOptions): FSOperationCancelledError | undefined {
    if (!options.signal?.aborted) return undefined;
    const reason = options.signal.reason;
    return reason instanceof FSOperationCancelledError ? reason : new FSOperationCancelledError();
}

/** A scope cannot know how far work got; read cancellation on the wire is not proof that work never started. */
export function stagedCancellation(error: FSOperationCancelledError, sent: boolean): FSOperationCancelledError {
    return !sent || error.outcome !== 'not-started' ? error : new FSOperationCancelledError('not-committed', error.timedOut);
}

export async function pause(ms: number, options: OperationOptions): Promise<void> {
    checkOperation(options);
    await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new FSOperationCancelledError()); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, ms);
        options.signal?.addEventListener('abort', abort, { once: true });
    });
}
