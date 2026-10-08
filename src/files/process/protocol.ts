import { FSError } from '@itookit/vfs-core';
import type { ProcessStatus } from './contracts';

export function validateStatus(status: ProcessStatus): void {
    if (!status || !['running', 'exited', 'cancelled', 'timed-out', 'failed', 'unknown'].includes(status.state)
        || typeof status.stdout !== 'string' || typeof status.stderr !== 'string' || typeof status.truncated !== 'boolean'
        || !(status.error === null || typeof status.error === 'string')
        || !(status.code === null || Number.isInteger(status.code))) throw new FSError('EIO', 'Invalid remote process status');
}
