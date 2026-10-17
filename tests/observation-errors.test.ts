import { afterEach, expect, it, vi } from 'vitest';
import { connectionLost, ObservationErrors } from '../src/harness/observation-errors';

afterEach(() => vi.restoreAllMocks());

it('requires transport evidence to classify an observation failure as offline', () => {
    expect(connectionLost(new TypeError('fetch failed'))).toBe(true);
    expect(connectionLost({code: 'CLIENT_HTTP_ERROR', cause: {code: 'ECONNREFUSED'}})).toBe(true);
    for (const code of ['EIO', 'EACCES', 'REQUEST_TIMEOUT', 'CLIENT_HTTP_NOT_IMPLEMENTED'])
        expect(connectionLost({code})).toBe(false);
    expect(connectionLost(new SyntaxError('Malformed response'))).toBe(false);
    const cyclic: {cause?: unknown} = {}; cyclic.cause = cyclic;
    expect(connectionLost(cyclic)).toBe(false);
});

it('deduplicates safe diagnostic codes until recovery without logging error bodies', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = new ObservationErrors('profile', 'session');
    const failure = {code: 'EIO', message: 'private body', headers: {authorization: 'private credential'}};
    expect(errors.record('inspect', failure)).toEqual({stage: 'inspect', code: 'EIO'});
    errors.record('inspect', failure); expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    errors.clear('inspect'); errors.record('inspect', failure); expect(warn).toHaveBeenCalledTimes(2);
    expect(errors.record('history', {code: 'secret/path?token=value'}).code).toBe('OBSERVATION_ERROR');
});
