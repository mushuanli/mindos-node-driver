import type { OperationOptions } from '@itookit/vfs-core';

export interface RemoteProcessSpec {
    serverId: string;
    epoch: string;
    cwd: string;
    mounts: readonly { alias: string; path: string; at: string; access: 'ro' | 'rw' }[];
}
export interface ProcessStatus {
    state: 'running' | 'exited' | 'cancelled' | 'timed-out' | 'failed' | 'unknown';
    stdout: string; stderr: string; code: number | null; error: string | null; truncated: boolean;
}
/** Public because HttpProcessSession.nativeShell exposes it; DTS emit needs a nameable type. */
export interface ExecOptions extends OperationOptions { cwd?: string; onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void; }
