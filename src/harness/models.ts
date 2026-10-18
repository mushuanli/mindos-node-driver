import {FSError} from '@itookit/vfs-core';
import type {HarnessModelCatalog, HarnessModelSelection} from './contracts';

function string(value: unknown, limit = 1024): value is string {return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');}
export function validateModelSelection(value: unknown): HarnessModelSelection {
    const row = value as HarnessModelSelection;
    if (!row || !string(row.modelId) || row.reasoningEffort !== undefined && !string(row.reasoningEffort, 128)) throw new FSError('EINVAL', 'Invalid native model selection');
    return {modelId: row.modelId, ...(row.reasoningEffort !== undefined ? {reasoningEffort: row.reasoningEffort} : {})};
}
export function validateModels(value: unknown): HarnessModelCatalog {
    const catalog = value as HarnessModelCatalog;
    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length > 512) throw new FSError('EIO', 'Invalid native model catalog');
    const ids = new Set<string>();
    const models = catalog.models.map(row => {
        if (!row || !string(row.id) || ids.has(row.id) || !string(row.label) || !Array.isArray(row.reasoningEfforts) || row.reasoningEfforts.length > 32) throw new FSError('EIO', 'Invalid native model');
        ids.add(row.id);
        const efforts = new Set<string>();
        const reasoningEfforts = row.reasoningEfforts.map(effort => {
            if (!effort || !string(effort.id, 128) || !string(effort.label) || efforts.has(effort.id)) throw new FSError('EIO', 'Invalid native reasoning effort');
            efforts.add(effort.id); return {id: effort.id, label: effort.label};
        });
        if (row.defaultReasoningEffort != null && !efforts.has(row.defaultReasoningEffort)) throw new FSError('EIO', 'Invalid default reasoning effort');
        return {id: row.id, label: row.label, reasoningEfforts, ...(row.defaultReasoningEffort ? {defaultReasoningEffort: row.defaultReasoningEffort} : {})};
    });
    return {models, ...(catalog.current ? {current: validateModelSelection(catalog.current)} : {}), ...(catalog.default ? {default: validateModelSelection(catalog.default)} : {})};
}
export function validateAvailableSelection(value: unknown, catalog: HarnessModelCatalog): HarnessModelSelection {
    const selected = validateModelSelection(value), row = catalog.models.find(row => row.id === selected.modelId);
    if (!row || selected.reasoningEffort !== undefined && !row.reasoningEfforts.some(effort => effort.id === selected.reasoningEffort)) throw new FSError('ECAPABILITY', 'Native model selection unavailable');
    return selected;
}
