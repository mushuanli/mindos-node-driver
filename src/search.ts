import { FSError } from '@itookit/vfs-core';
export interface FileSearchMatch { path: string; line?: number; summary: string }
export interface FileSearchResult { matches: FileSearchMatch[]; truncated: boolean; nextCursor: null }
export interface FileSearchQuery { query: string; mode: 'path' | 'content' }
export function validateFileSearch(value: unknown): FileSearchResult {
    const result = value as FileSearchResult | undefined;
    if (!result || !Array.isArray(result.matches) || result.matches.length > 100 || typeof result.truncated !== 'boolean' || result.nextCursor !== null)
        throw new FSError('EIO', 'Invalid file search response');
    for (const match of result.matches) if (!match || typeof match.path !== 'string' || !match.path || match.path.startsWith('/')
        || match.path.split('/').some(part => !part || part === '.' || part === '..') || match.path.includes('\0')
        || typeof match.summary !== 'string' || match.summary.length > 2000
        || match.line !== undefined && (!Number.isSafeInteger(match.line) || match.line < 1)) throw new FSError('EIO', 'Invalid file search match');
    return result;
}
