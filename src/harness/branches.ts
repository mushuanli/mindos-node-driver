import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessClient, HarnessSession } from './contracts';
/** Native parent links define a branch family; project-scoped listing enforces visibility. */
export async function conversationBranches(client: HarnessClient, profileId: string, current: HarnessSession, options: OperationOptions): Promise<HarnessSession[]> {
    const sessions = new Map<string, HarnessSession>([[current.id,current]]);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
        const page = await client.list(profileId, {cursor}, options);
        for (const session of page.sessions) sessions.set(session.id, session);
        cursor = page.nextCursor ?? undefined;
        if (sessions.size > 10_000 || cursors.size >= 1000 || cursor && cursors.has(cursor)) throw new FSError('EFBIG','Harness branch listing limit');
        if (cursor) cursors.add(cursor);
    } while (cursor);
    const root = ancestor(sessions.get(current.id)!, sessions);
    return [...sessions.values()].filter(session => ancestor(session, sessions) === root);
}
function ancestor(session: HarnessSession, sessions: Map<string,HarnessSession>): string {
    const visited = new Set<string>();
    while (session.parentSessionId) {
        if (visited.has(session.id)) throw new FSError('EIO','Cyclic native branch family');
        visited.add(session.id);
        const parent = sessions.get(session.parentSessionId);
        if (!parent) return session.parentSessionId;
        session = parent;
    }
    return session.id;
}
