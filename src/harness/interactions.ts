import type {HarnessEvent} from './contracts';

export interface HarnessQuestion {
    id: string; question: string; header?: string; multiSelect?: boolean; isSecret?: boolean; isOther?: boolean;
    options?: Array<{label: string; description?: string}>;
}
export interface HarnessRequest {
    id: string | number; kind: 'approval' | 'input' | 'unsupported'; detail: string; title?: string;
    questions?: HarnessQuestion[]; decisions?: string[]; responding?: boolean;
}
export function nativeRequest(request: HarnessEvent['message']): HarnessRequest[] {
    if (request.id === undefined) return [];
    const params = request.params ?? {};
    let kind: HarnessRequest['kind'] = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)
        ? 'approval' : request.method === 'item/tool/requestUserInput' ? 'input' : 'unsupported';
    const questions = Array.isArray(params.questions) ? params.questions.map(question) : undefined;
    if (kind === 'input' && (!questions?.length || questions.some(q => !q) || new Set(questions.map(q => q?.id)).size !== questions.length)) kind = 'unsupported';
    const offered = params.decisions ?? params.availableDecisions;
    const decisions = Array.isArray(offered) ? offered.filter((value): value is string => typeof value === 'string' && ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)) : undefined;
    if (kind === 'approval' && Array.isArray(offered) && decisions?.length !== offered.length) kind = 'unsupported';
    const detail = kind === 'unsupported' ? JSON.stringify(params, null, 2)
        : ['reason', 'command', 'path', 'toolName'].flatMap(key => typeof params[key] === 'string' ? [params[key]] : []).join('\n');
    return [{id: request.id, kind, detail, questions: questions?.filter((q): q is HarnessQuestion => !!q), decisions}];
}
function question(value: unknown): HarnessQuestion | undefined {
    if (!value || typeof value !== 'object') return;
    const q = value as Record<string, unknown>;
    if (typeof q.id !== 'string' || !q.id || typeof q.question !== 'string') return;
    if (['multiSelect', 'isSecret', 'isOther'].some(key => q[key] !== undefined && typeof q[key] !== 'boolean')) return;
    const options = Array.isArray(q.options) ? q.options : undefined;
    if (q.options != null && !options || options?.some(o => !o || typeof o.label !== 'string' || !o.label || o.label.includes('\0')
        || o.description !== undefined && typeof o.description !== 'string')) return;
    return {id: q.id, question: q.question, header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect as boolean | undefined, isSecret: q.isSecret as boolean | undefined,
        isOther: q.isOther as boolean | undefined, options: options?.map(o => ({label: o.label, description: o.description}))};
}
