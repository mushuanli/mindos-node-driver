type Item = Record<string, unknown>;
export type ToolOperation = 'read' | 'write' | 'search' | 'list' | 'execute';

/** Keep declared targets and a bounded first command line, without full payloads or results. */
export function toolSummary(item: Item, type: string): {name: string; paths: string[]; operation: ToolOperation; commandPreview?: string} {
    const name = String(item.tool ?? item.name ?? type).slice(0, 256), paths = new Set<string>();
    const argument = item.arguments ?? item.input;
    let input = argument;
    if (typeof argument === 'string') { try { input = JSON.parse(argument); } catch { /* Opaque harness inputs have no declared paths. */ } }
    collectPaths(item, paths); collectPaths(input, paths);
    if (typeof argument === 'string') for (const line of argument.split('\n')) {
        const target = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)?.[1];
        if (target && paths.size < 32) paths.add(target.slice(0, 1024));
    }
    const command = String(item.command ?? (input as Item | null)?.cmd ?? (input as Item | null)?.command ?? (input as Item | null)?.code
        ?? (['exec', 'exec_command', 'shell', 'bash'].includes(name) && typeof input === 'string' ? input : ''));
    commandPaths(command).forEach(path => { if (paths.size < 32) paths.add(path.slice(0, 1024)); });
    const line = String(item.commandPreview ?? command).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
    const commandPreview = [...line].slice(0, 240).join('') + ([...line].length > 240 ? '…' : '');
    const action = String(item.operation ?? item.type ?? name).toLowerCase(), hint = `${name} ${commandPreview}`.toLowerCase();
    const operation: ToolOperation = ['read', 'write', 'search', 'list', 'execute'].includes(action) ? action as ToolOperation
        : /change|patch|write|edit/.test(action + ' ' + hint) ? 'write' : /search|grep|\brg\b/.test(hint) ? 'search'
        : /read|\bcat\b|\bsed\b/.test(hint) ? 'read' : /list|\bls\b/.test(hint) ? 'list' : 'execute';
    return {name, paths: [...paths].slice(0, 32), operation, ...(commandPreview ? {commandPreview} : {})};
}
function collectPaths(value: unknown, paths: Set<string>, depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 4 || paths.size >= 32) return;
    for (const [key, child] of Object.entries(value)) {
        if (paths.size >= 32) break;
        if (['path', 'file_path', 'filePath', 'filename', 'target', 'cwd', 'workdir'].includes(key) && typeof child === 'string') paths.add(child.slice(0, 1024));
        else if (['paths', 'files'].includes(key) && Array.isArray(child)) for (const path of child.slice(0, 32)) { if (typeof path === 'string' && paths.size < 32) paths.add(path.slice(0, 1024)); }
        else if (Array.isArray(child)) child.slice(0, 32).forEach(part => collectPaths(part, paths, depth + 1));
        else if (child && typeof child === 'object') collectPaths(child, paths, depth + 1);
    }
}
function commandPaths(command: string): string[] {
    if (/[|;&<>`\n]/.test(command)) return [];
    const [tool, ...tokens] = command.trim().split(/\s+/), name = tool?.split('/').at(-1);
    if (!name || !['cat', 'head', 'tail', 'ls', 'find', 'rg', 'grep', 'sed'].includes(name)) return [];
    if (tokens.some(token => token.startsWith('-') && !['-n', '-i', '-l', '-r', '-R', '-S', '-s', '--hidden'].includes(token))) return [];
    const operands = tokens.filter(token => !token.startsWith('-'));
    if (['rg', 'grep', 'sed'].includes(name)) operands.shift();
    return operands.filter(path => !/["']/.test(path) && !path.includes('://') && (/^[./~]/.test(path) || /\.[a-zA-Z0-9]{1,8}$/.test(path)));
}
