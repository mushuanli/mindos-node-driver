import {expect, it, vi} from 'vitest';
import {validateModels} from '../src/harness/models';
import {MCPHarnessClient} from '../src/harness/client';

const catalog = {models: [{id: 'native', label: 'Native model', reasoningEfforts: [{id: 'high', label: 'High'}]}]};
it('keeps native reasoning ids and rejects duplicate or malformed catalogs', () => {
    expect(validateModels(catalog)).toEqual(catalog);
    expect(() => validateModels({models: [...catalog.models, ...catalog.models]})).toThrow();
    expect(() => validateModels({models: [{...catalog.models[0], reasoningEfforts: [{id: 3, label: 'Invalid'}]}]})).toThrow();
    expect(() => validateModels({...catalog, current: {modelId: '', reasoningEffort: 'high'}})).toThrow();
});
it('queries the authorized catalog and sends a captured selection in the receipted turn', async () => {
    const call = vi.fn(async (name: string, args: any) => name === 'harness_models' ? catalog
        : name === 'harness_profiles' ? {epoch: 'e', profiles: []} : {requestId: args.requestId, outcome: 'committed', result: {turnId: 't'}});
    const client = new MCPHarnessClient({call, close: vi.fn()} as never, {projectId: 'p', revision: 2});
    await expect(client.models('profile', 'session')).resolves.toEqual(catalog);
    expect(call).toHaveBeenCalledWith('harness_models', {projectId: 'p', revision: 2, profileId: 'profile', sessionId: 'session'}, undefined);
    await client.turn('profile', 'session', 'Prompt', {requestId: 'op', selection: {modelId: 'native', reasoningEffort: 'high'}});
    expect(call).toHaveBeenCalledWith('harness_turn', expect.objectContaining({requestId: 'op', selection: {modelId: 'native', reasoningEffort: 'high'}, projectId: 'p'}), expect.anything());
});
