import {beforeEach, describe, test} from '@jest/globals';
import assert from 'node:assert/strict';
import {MockAgent, setGlobalDispatcher} from 'undici';

// ─── Setup ────────────────────────────────────────────────────────────────────

let mockAgent;

beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function intercept({origin, path, method = 'GET', times = 1, status, body, headers = {}}) {
    const isObject = typeof body === 'object' && body !== null;
    const replyBody = isObject ? JSON.stringify(body) : body;

    const replyHeaders = {...headers};
    if (isObject && !replyHeaders['content-type']) {
        replyHeaders['content-type'] = 'application/json';
    }

    mockAgent.get(origin)
        .intercept({path, method})
        .reply(status, replyBody, {headers: replyHeaders})
        .times(times);
}

// ─── Module under test ────────────────────────────────────────────────────────

// Import config so our mocks dynamically match whatever is in .env
const {API_BASE_URL, API_DETAIL_URL} = await import('../src/config/config.js');
const {fetchTrialDetail, fetchStudiesPage} = await import('../src/http/api.js');

const NCT_ID = 'NCT07697053';

// Safely extract origins and base paths to ensure mock accuracy
const detailUrlObj = new URL(API_DETAIL_URL);
const baseUrlObj = new URL(API_BASE_URL);

const ORIGIN_DETAIL = detailUrlObj.origin;
const PATH_DETAIL = detailUrlObj.pathname.replace(/\/$/, ''); // strip trailing slash

const ORIGIN_BASE = baseUrlObj.origin;
const PATH_BASE = baseUrlObj.pathname.replace(/\/$/, '');

// ─── fetchTrialDetail ─────────────────────────────────────────────────────────

describe('fetchTrialDetail', () => {

    describe('happy path', () => {
        test('returns parsed JSON on 200', async () => {
            const payload = {study: {nctId: NCT_ID}, history: {changes: [1, 2]}};
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}?history=true`,
                status: 200,
                body: payload,
            });

            const data = await fetchTrialDetail(NCT_ID, {history: true});
            assert.deepEqual(data, payload);
        });
    });

    describe('404 handling', () => {
        test('throws TrialNotFoundError with the nctId (not URL) as code', async () => {
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}?history=true`,
                status: 404,
                body: '', // <--- Change from object to empty string
            });

            await assert.rejects(
                () => fetchTrialDetail(NCT_ID, {history: true}),
                (err) => {
                    assert.equal(err.name, 'TrialNotFoundError');
                    assert.equal(err.code, NCT_ID);
                    return true;
                },
            );
        });
    });

    describe('non-ok HTTP error', () => {
        test('throws TrialFetchError on 500 after all retries exhausted', async () => {
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}?history=true`,
                status: 500,
                body: 'Internal Server Error',
                times: 4,
            });

            await assert.rejects(
                () => fetchTrialDetail(NCT_ID, {history: true}),
                (err) => {
                    assert.equal(err.name, 'TrialFetchError'); // Replaced instanceof
                    assert.equal(err.status, 500);
                    assert.equal(err.isTransient, true);
                    assert.match(err.message, /Failed to fetch/);
                    return true;
                },
            );
        }, 15000);

        test('throws TrialFetchError on 429 and exposes retryAfterMs', async () => {
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}?history=true`,
                status: 429,
                body: 'Too Many Requests',
                headers: {'retry-after': '2'},
                times: 4,
            });

            await assert.rejects(
                () => fetchTrialDetail(NCT_ID, {history: true}),
                (err) => {
                    assert.equal(err.name, 'TrialFetchError'); // Replaced instanceof
                    assert.equal(err.status, 429);
                    assert.equal(err.isTransient, true);
                    assert.ok(err.retryAfterMs >= 2000);
                    return true;
                },
            );
        }, 15000);

        test('throws TrialFetchError on 429 and falls back to default retry-after when header is empty', async () => {
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}?history=true`,
                status: 429,
                body: 'Too Many Requests',
                headers: {'retry-after': ''},
                times: 4,
            });

            await assert.rejects(
                () => fetchTrialDetail(NCT_ID, {history: true}),
                (err) => {
                    assert.equal(err.name, 'TrialFetchError');
                    assert.equal(err.status, 429);
                    assert.equal(err.isTransient, true);
                    assert.ok(err.retryAfterMs === 50);
                    return true;
                },
            );
        });

        test('throws TrialFetchError on 400 without retrying (non-retryable)', async () => {
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}?history=true`,
                status: 400,
                body: {error: 'Bad Request'},
                times: 1,
            });

            await assert.rejects(
                () => fetchTrialDetail(NCT_ID, {history: true}),
                (err) => {
                    assert.equal(err.name, 'TrialFetchError'); // Replaced instanceof
                    assert.equal(err.status, 400);
                    assert.equal(err.isTransient, false);
                    return true;
                },
            );
            mockAgent.assertNoPendingInterceptors();
        });
    });

    describe('input validation', () => {
        test('throws TrialValidationError on empty string nctId', async () => {
            await assert.rejects(
                () => fetchTrialDetail(''),
                (err) => {
                    assert.equal(err.name, 'TrialValidationError');
                    assert.match(err.message, /nctId/i);
                    return true;
                },
            );
        });

        test('throws TrialValidationError on non-string nctId', async () => {
            await assert.rejects(
                () => fetchTrialDetail(12345),
                (err) => {
                    assert.equal(err.name, 'TrialValidationError');
                    return true;
                },
            );
        });
    });

    describe('params forwarding', () => {
        test('serialises { history: true } into the query string', async () => {
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}?history=true`,
                status: 200,
                body: {},
            });

            await fetchTrialDetail(NCT_ID, {history: true});
            mockAgent.assertNoPendingInterceptors();
        });

        test('builds URL without query string when no params are passed', async () => {
            intercept({
                origin: ORIGIN_DETAIL,
                path: `${PATH_DETAIL}/${NCT_ID}`,
                status: 200,
                body: {},
            });

            await fetchTrialDetail(NCT_ID);
            mockAgent.assertNoPendingInterceptors();
        });
    });
});

// ─── fetchStudiesPage ─────────────────────────────────────────────────────────

describe('fetchStudiesPage', () => {

    describe('happy path', () => {
        test('returns parsed JSON on 200', async () => {
            const payload = {studies: [{nctId: 'NCT001'}], nextPageToken: 'abc'};
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=10&countTotal=true`,
                status: 200,
                body: payload,
            });

            const data = await fetchStudiesPage({pageSize: 10, countTotal: true});
            assert.deepEqual(data, payload);
        });
    });

    describe('input validation', () => {
        test('throws TrialValidationError when pageSize < 1', async () => {
            await assert.rejects(
                () => fetchStudiesPage({pageSize: 0}),
                (err) => {
                    assert.equal(err.name, 'TrialValidationError');
                    return true;
                },
            );
        });
    });

    describe('URL construction', () => {
        test('always includes pageSize and countTotal=true', async () => {
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=25&countTotal=true`,
                status: 200,
                body: {studies: []},
            });

            await fetchStudiesPage({pageSize: 25, countTotal: true});
            mockAgent.assertNoPendingInterceptors();
        });

        test('appends pageToken when provided', async () => {
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=10&countTotal=true&pageToken=token123`,
                status: 200,
                body: {studies: []},
            });

            await fetchStudiesPage({pageSize: 10, countTotal: true, pageToken: 'token123'});
            mockAgent.assertNoPendingInterceptors();
        });

        test('appends comma-separated fields when provided', async () => {
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=10&countTotal=true&fields=NCTId%2CTitle%2CStatus`,
                status: 200,
                body: {studies: []},
            });

            await fetchStudiesPage({pageSize: 10, countTotal: true, fields: ['NCTId', 'Title', 'Status']});
            mockAgent.assertNoPendingInterceptors();
        });

        test('omits pageToken and fields when not provided', async () => {
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=10&countTotal=true`,
                status: 200,
                body: {studies: []},
            });

            await fetchStudiesPage({pageSize: 10, countTotal: true});
            mockAgent.assertNoPendingInterceptors();
        });
    });

    describe('retry behaviour', () => {
        test('retries on 503 and succeeds on the third attempt', async () => {
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=10&countTotal=true`,
                status: 503,
                body: 'Service Unavailable',
                times: 2,
            });
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=10&countTotal=true`,
                status: 200,
                body: {studies: []},
            });

            const data = await fetchStudiesPage({pageSize: 10, countTotal: true});
            assert.deepEqual(data, {studies: []});
            mockAgent.assertNoPendingInterceptors();
        });

        test('throws TrialFetchError after all retries on persistent 503', async () => {
            intercept({
                origin: ORIGIN_BASE,
                path: `${PATH_BASE}?pageSize=10&countTotal=true`,
                status: 503,
                body: 'Service Unavailable',
                times: 4,
            });

            await assert.rejects(
                () => fetchStudiesPage({pageSize: 10, countTotal: true}),
                (err) => {
                    assert.equal(err.name, 'TrialFetchError'); // Replaced instanceof
                    assert.equal(err.status, 503);
                    assert.equal(err.isTransient, true);
                    return true;
                },
            );
        }, 15000);
    });
});
