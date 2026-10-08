import type { HarnessHistory, HarnessEvent } from './contracts';
import { FSError } from '@itookit/vfs-core';
import { toolSummary, type ToolOperation } from './tool-summary';
export interface HarnessMessage {
    id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: string;
    contentParts?: string[];
    turnId?: string; name?: string; input?: string; inputLanguage?: 'bash' | 'json' | 'text';
    timestamp?: number; paths?: string[]; operation?: ToolOperation; commandPreview?: string;
}
export interface HarnessRequest { id: string | number; kind: 'approval' | 'input' | 'unsupported'; detail: string; questions?: Array<{id: string; question: string; options?: Array<{label: string}>}> }
export function nativeMessage(value: unknown, fallback: string, turnId?: string, at?: number): HarnessMessage | undefined {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>, type = String(item.type ?? '');
    const role = type === 'userMessage' ? 'user' : type === 'agentMessage' ? 'assistant' : /Execution|Change|[Tt]oolCall|toolOutput|webSearch|imageGeneration/.test(type) ? 'tool' : 'system';
    if (type === 'toolOutput') return;
    const summary = role === 'tool' ? toolSummary(item, type) : undefined;
    const parts = [...textParts(item.summary), ...textParts(item.content)], content = parts.join('\n');
    const text = summary?.name ?? (typeof item.text === 'string' ? item.text : typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : content);
    if (!text) return;
    return {id: typeof item.id === 'string' ? item.id : fallback, role, text, turnId: typeof item.turnId === 'string' ? item.turnId : turnId,
        timestamp: messageTime(item.timestamp ?? item.createdAt ?? item.startedAt) ?? at,
        status: typeof item.status === 'string' ? item.status : undefined,
        ...(role === 'user' && Array.isArray(item.content) && typeof item.text !== 'string' ? {contentParts: parts} : {}), ...summary};
}
export function messageTime(value: unknown): number | undefined {
    const time = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value < 100_000_000_000 ? value * 1000 : value : NaN;
    return Number.isFinite(time) && time > 0 ? time : undefined;
}
function textParts(value: unknown): string[] {
    if (typeof value === 'string') return value ? [value] : [];
    if (Array.isArray(value)) return value.flatMap(textParts);
    if (!value || typeof value !== 'object') return [];
    const part = value as {text?: unknown; content?: unknown};
    return textParts(typeof part.text === 'string' ? part.text : part.content);
}
export function historyMessages(history: HarnessHistory): HarnessMessage[] {
    return boundMessages((history.turns ?? []).flatMap((turn, t) => {
        const row = turn as {id?: unknown; items?: unknown[]; createdAt?: unknown; startedAt?: unknown};
        const turnId = typeof row?.id === 'string' && row.id !== 'rollout-history' ? row.id : undefined;
        const at = messageTime(row.createdAt ?? row.startedAt);
        return Array.isArray(row?.items) ? row.items.flatMap((item, i) => nativeMessage(item, `history:${turnId ?? t}:${i}`, turnId, at) ?? []) : [];
    }));
}
export function nativeRequest(request: HarnessEvent['message']): HarnessRequest[] {
    if (request.id === undefined) return [];
    const kind = ['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method) ? 'approval'
        : request.method === 'item/tool/requestUserInput' ? 'input' : 'unsupported';
    const raw = request.params?.questions;
    const questions = Array.isArray(raw) ? raw.filter(q => q && typeof q.id === 'string' && typeof q.question === 'string').map(q => ({id: q.id, question: q.question, options: Array.isArray(q.options) ? q.options.filter((o: unknown) => o && typeof (o as {label?: unknown}).label === 'string') : undefined})) : undefined;
    return [{ id: request.id, kind, detail: JSON.stringify(request.params ?? {}, null, 2), questions }];
}

/** Reject capacity overflow explicitly rather than silently deleting requested history. */
export function boundMessages(messages: HarnessMessage[]): HarnessMessage[] {
    const encoder = new TextEncoder();
    if (messages.length > 10_000 || messages.reduce((size, message) => size + encoder.encode(JSON.stringify(message)).byteLength, 0) > 32 * 1024 * 1024) throw new FSError('EFBIG', 'Conversation history capacity reached');
    return messages;
}
export function mergeMessages(first: HarnessMessage[], second: HarnessMessage[]): HarnessMessage[] {
    const messages = [...new Map([...first, ...second].map(message => [message.id, message])).values()];
    if (messages.every(message => message.timestamp !== undefined)) messages.sort((left, right) => left.timestamp! - right.timestamp!);
    return boundMessages(messages);
}
