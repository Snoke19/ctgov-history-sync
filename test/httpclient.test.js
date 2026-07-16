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

function intercept({origin, path, method = 'GET', times = 1, status, body, headers = {}, delay}) {
    const isObject = typeof body === 'object' && body !== null;
    const replyBody = isObject ? JSON.stringify(body) : body;

    const replyHeaders = {...headers};
    if (isObject && !replyHeaders['content-type']) {
        replyHeaders['content-type'] = 'application/json';
    }

    let interceptor = mockAgent.get(origin)
        .intercept({path, method})
        .reply(status, replyBody, {headers: replyHeaders});

    if (delay) interceptor = interceptor.delay(delay);
    interceptor.times(times);
}

// ─── Module under test ────────────────────────────────────────────────────────

const {
    fetchWithRetry,
    parseJsonResponse,
    calculateBackoff,
    parseRetryAfterHeader,
    RETRYABLE_STATUS_CODES,
} = await import('../src/http/httpClient.js');

const ORIGIN = 'http://test.local';

// ─── RETRYABLE_STATUS_CODES ────────────────────────────────────────────────────

describe('RETRYABLE_STATUS_CODES', () => {
    test('includes the standard transient statuses and excludes client error', () => {
        for (const code of [408, 429, 500, 502, 503, 504]) {
            assert.ok(RETRYABLE_STATUS_CODES.has(code), `expected ${code} to be retryable`);
        }
        assert.ok(!RETRYABLE_STATUS_CODES.has(400));
        assert.ok(!RETRYABLE_STATUS_CODES.has(404));
    });
});

// ─── calculateBackoff ─────────────────────────────────────────────────────────

describe('calculateBackoff', () => {
    test('prioritises a positive retryAfterMs over exponential backoff', () => {
        assert.equal(calculateBackoff(5, 1234), 1234);
    });

    test('ignores a zero or negative retryAfterMs and falls back to exponential backoff', () => {
        assert.ok(calculateBackoff(0, 0) > 0);
        assert.ok(calculateBackoff(0, -500) > 0);
    });

    test('grows with each attempt', () => {
        assert.ok(calculateBackoff(4) > calculateBackoff(0));
    });

    test('never exceeds the 30s cap', () => {
        assert.ok(calculateBackoff(20) <= 30_000);
    });
});

// ─── parseRetryAfterHeader ────────────────────────────────────────────────────

describe('parseRetryAfterHeader', () => {
    test('returns null when the header is absent', () => {
        const response = new Response(null, {headers: {}});
        assert.equal(parseRetryAfterHeader(response), null);
    });

    test('parses integer-seconds form into milliseconds', () => {
        const response = new Response(null, {headers: {'Retry-After': '5'}});
        assert.equal(parseRetryAfterHeader(response), 5000);
    });

    test('parses HTTP-date form into a millisecond offset', () => {
        const future = new Date(Date.now() + 10_000).toUTCString();
        const response = new Response(null, {headers: {'Retry-After': future}});
        const parsed = parseRetryAfterHeader(response);
        assert.ok(parsed > 8000 && parsed <= 10_000);
    });

    test('falls back to the default when the header is unparseable', async () => {
        const {DEFAULT_RETRY_AFTER_MS} = await import('../src/config/config.js');
        const response = new Response(null, {headers: {'Retry-After': 'not-a-date'}});
        assert.equal(parseRetryAfterHeader(response), DEFAULT_RETRY_AFTER_MS);
    });
});

// ─── fetchWithRetry ───────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
    test('returns the response on the first success', async () => {
        intercept({origin: ORIGIN, path: '/ok', status: 200, body: {ok: true}});

        const response = await fetchWithRetry(`${ORIGIN}/ok`);
        assert.equal(response.status, 200);
    });

    test('retries a retryable status and eventually succeeds', async () => {
        intercept({origin: ORIGIN, path: '/flaky', status: 503, body: 'busy', times: 1});
        intercept({origin: ORIGIN, path: '/flaky', status: 200, body: {ok: true}, times: 1});

        const response = await fetchWithRetry(`${ORIGIN}/flaky`, {maxRetries: 2});
        assert.equal(response.status, 200);
        mockAgent.assertNoPendingInterceptors();
    });

    test('passes through a non-retryable status response without retrying', async () => {
        intercept({origin: ORIGIN, path: '/bad', status: 400, body: 'nope', times: 1});

        const response = await fetchWithRetry(`${ORIGIN}/bad`, {maxRetries: 3});
        assert.equal(response.status, 400);
        mockAgent.assertNoPendingInterceptors();
    });

    test('wraps a response that exceeds timeoutMs as TrialTimeoutError', async () => {
        intercept({origin: ORIGIN, path: '/slow', status: 200, body: {ok: true}, delay: 200});

        await assert.rejects(
            () => fetchWithRetry(`${ORIGIN}/slow`, {timeoutMs: 20, maxRetries: 0}),
            (err) => {
                assert.equal(err.name, 'TrialTimeoutError');
                assert.equal(err.url, `${ORIGIN}/slow`);
                assert.equal(err.timeoutMs, 20);
                return true;
            },
        );
    });
});

// ─── parseJsonResponse ────────────────────────────────────────────────────────

describe('parseJsonResponse', () => {
    test('parses a valid JSON body', async () => {
        const response = new Response(JSON.stringify({a: 1}), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        const data = await parseJsonResponse(response, `${ORIGIN}/x`);
        assert.equal(JSON.stringify(data), JSON.stringify({a: 1}));
    });

    test('returns null on 404 when allow404 is true', async () => {
        const response = new Response(null, {status: 404});
        const data = await parseJsonResponse(response, `${ORIGIN}/x`, {allow404: true});
        assert.equal(data, null);
    });

    test('throws a transient TrialFetchError on a retryable non-ok status', async () => {
        const response = new Response('Internal Server Error', {status: 500});

        await assert.rejects(
            () => parseJsonResponse(response, `${ORIGIN}/x`),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.status, 500);
                assert.equal(err.isTransient, true);
                return true;
            },
        );
    });

    test('throws a non-transient TrialFetchError on a non-retryable non-ok status', async () => {
        const response = new Response('Bad Request', {status: 400});

        await assert.rejects(
            () => parseJsonResponse(response, `${ORIGIN}/x`),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.status, 400);
                assert.equal(err.isTransient, false);
                return true;
            },
        );
    });

    test('throws a non-transient TrialFetchError on malformed JSON', async () => {
        const response = new Response('{not valid json', {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        await assert.rejects(
            () => parseJsonResponse(response, `${ORIGIN}/x`),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.isTransient, false);
                assert.match(err.cause.message, /Invalid JSON/);
                return true;
            },
        );
    });
});
