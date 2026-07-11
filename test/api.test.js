import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from '../src/errors.js';

function mockFetch(status, body, {throwError} = {}) {
    globalThis.fetch = async () => {
        if (throwError) throw throwError;
        return {
            status,
            statusText: status === 200 ? 'OK' : 'Error',
            ok: status >= 200 && status < 300,
            json: async () => body,
        };
    };
}

const {fetchTrial} = await import('../src/api.js');

const CODE = 'NCT07697053';
const PARAMS = {history: true};

describe('fetchTrial', () => {

    describe('happy path', () => {
        it('returns parsed JSON on 200', async () => {
            const payload = {study: {nctId: CODE}, history: {changes: [1, 2]}};
            mockFetch(200, payload);
            const data = await fetchTrial(CODE, PARAMS);
            assert.deepEqual(data, payload);
        });
    });

    describe('404 handling', () => {
        it('throws TrialNotFoundError on 404', async () => {
            mockFetch(404, null);
            await assert.rejects(
                () => fetchTrial(CODE, PARAMS),
                (err) => {
                    assert.ok(err instanceof TrialNotFoundError);
                    assert.equal(err.code, CODE);
                    return true;
                }
            );
        });
    });

    describe('non-ok HTTP errors', () => {
        it('throws TrialFetchError on 500', async () => {
            mockFetch(500, null);
            await assert.rejects(
                () => fetchTrial(CODE, PARAMS),
                (err) => {
                    assert.ok(err instanceof TrialFetchError);
                    assert.match(err.message, /Failed to fetch/);
                    return true;
                }
            );
        });

        it('throws TrialFetchError on 429', async () => {
            mockFetch(429, null);
            await assert.rejects(
                () => fetchTrial(CODE, PARAMS),
                (err) => {
                    assert.ok(err instanceof TrialFetchError);
                    return true;
                }
            );
        });
    });

    describe('network errors', () => {
        it('throws TrialFetchError on network failure', async () => {
            mockFetch(null, null, {throwError: new TypeError('fetch failed')});
            await assert.rejects(
                () => fetchTrial(CODE, PARAMS),
                (err) => {
                    assert.ok(err instanceof TrialFetchError);
                    assert.ok(err.cause instanceof TypeError);
                    return true;
                }
            );
        });

        it('throws TrialTimeoutError on timeout', async () => {
            const timeoutError = new DOMException('The operation was aborted', 'TimeoutError');
            mockFetch(null, null, {throwError: timeoutError});
            await assert.rejects(
                () => fetchTrial(CODE, PARAMS),
                (err) => {
                    assert.ok(err instanceof TrialTimeoutError);
                    assert.match(err.message, /timed out/i);
                    return true;
                }
            );
        });
    });

    describe('params forwarding', () => {
        it('passes params to URL — history=true produces correct query string', async () => {
            let capturedUrl;
            globalThis.fetch = async (url) => {
                capturedUrl = url;
                return {status: 200, ok: true, json: async () => ({})};
            };
            await fetchTrial(CODE, {history: true});
            assert.match(capturedUrl, /NCT07697053/);
            assert.match(capturedUrl, /history=true/);
        });

        it('builds URL without query string when no params passed', async () => {
            let capturedUrl;
            globalThis.fetch = async (url) => {
                capturedUrl = url;
                return {status: 200, ok: true, json: async () => ({})};
            };
            await fetchTrial(CODE);
            assert.match(capturedUrl, /NCT07697053$/);
        });
    });
});
