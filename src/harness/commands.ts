import {FSError} from '@itookit/vfs-core';
import type {HarnessSlashCommand, HarnessCommandResult} from './contracts';

export function validateCommandResult(value: unknown): HarnessCommandResult {
    const result = value as HarnessCommandResult;
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || ['turnId', 'commandId', 'output'].some(key => result[key as keyof HarnessCommandResult] !== undefined && typeof result[key as keyof HarnessCommandResult] !== 'string')
        || result.failed !== undefined && typeof result.failed !== 'boolean'
        || [result.turnId, result.commandId].some(id => id !== undefined && (!id || id.length > 1024))
        || (result.output?.length ?? 0) > 128 * 1024) throw new FSError('EIO', 'Invalid native command result');
    return {...(result.turnId !== undefined ? {turnId: result.turnId} : {}), ...(result.commandId !== undefined ? {commandId: result.commandId} : {}),
        ...(result.output !== undefined ? {output: result.output} : {}), ...(result.failed !== undefined ? {failed: result.failed} : {})};
}

export function validateCommandReceipts(value: unknown): HarnessCommandResult[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) throw new FSError('EIO', 'Invalid native command receipts');
    return value.map(row => {
        const result = validateCommandResult(row);
        if (!result.commandId || result.output === undefined) throw new FSError('EIO', 'Invalid native command receipt');
        return result;
    });
}

export function validateCommands(value: unknown): HarnessSlashCommand[] {
    const rows = (value as {commands?: unknown})?.commands;
    if (!Array.isArray(rows) || rows.length > 256) throw new FSError('EIO', 'Invalid native command catalog');
    const names = new Set<string>();
    return rows.map(row => {
        if (!row || typeof row.name !== 'string' || !/^[\p{L}\p{N}_:.-]{1,128}$/u.test(row.name)
            || names.has(row.name) || typeof row.description !== 'string' || row.description.length > 4096
            || row.argumentHint !== undefined && (typeof row.argumentHint !== 'string' || row.argumentHint.length > 512)
            || !['prompt', 'action'].includes(row.kind) || row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new FSError('EIO', 'Invalid native command');
        names.add(row.name);
        return {name: row.name, description: row.description, argumentHint: row.argumentHint, kind: row.kind, ...(row.disabled !== undefined ? {disabled: row.disabled} : {})};
    });
}
