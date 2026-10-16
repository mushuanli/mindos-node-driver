import { expect, it } from 'vitest';
import { harnessArchiveAllowed } from '../src/harness/state';
import type { HarnessSession } from '../src/harness/contracts';

const session: HarnessSession = {id: 's', title: 'Native', cwd: '/p', status: 'idle', updatedAt: null, resumable: true, owned: false};
it.each([
    [{}, false],
    [{archiveAllowed: true}, true],
    [{owned: true}, true],
    [{owned: true, archiveAllowed: false}, false],
    [{status: 'notLoaded'}, true],
    [{archiveAllowed: true, status: 'active'}, false],
    [{archiveAllowed: true, activeTurnId: 'turn'}, false],
    [{archiveAllowed: true, archived: true}, false],
    [{archiveAllowed: true, statusDetails: {type: 'idle', activeFlags: ['waitingOnApproval']}}, false],
] satisfies Array<[Partial<HarnessSession>, boolean]>)('keeps runtime guards when applying native eligibility %j', (changes, allowed) => {
    expect(harnessArchiveAllowed({...session, ...changes})).toBe(allowed);
});
