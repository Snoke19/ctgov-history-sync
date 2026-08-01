import {beforeEach, describe, test} from '@jest/globals';
import assert from 'node:assert/strict';
import {MockAgent, setGlobalDispatcher} from 'undici';
import {RETRYABLE_STATUS_CODES} from '../../src/config/config.js';
import {createHttpClient} from "../../src/http/httpClient.js";

let mockAgent;
let fetchJson;

beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const httpClient = createHttpClient({
        useProxy: false,
        useRateLimit: false,
        acquireTimeout: 1000,
    });

    fetchJson = httpClient.fetchJson;
});

function intercept({origin, path, method = 'GET', times = 1, status, body, headers = {}, delay}) {
    const isObject = typeof body === 'object' && body !== null;
    const replyBody = isObject ? JSON.stringify(body) : body;

    const replyHeaders = {...headers};
    if (isObject && !replyHeaders['content-type']) {
        replyHeaders['content-type'] = 'application/json';
    }

    let interceptor = mockAgent
        .get(origin)
        .intercept({path, method})
        .reply(status, replyBody, {headers: replyHeaders});

    if (delay) interceptor = interceptor.delay(delay);
    interceptor.times(times);
}

const {calculateBackoff, parseRetryAfterHeader} =
    await import('../../src/http/retry/retryPolicy.js');

const ORIGIN = 'http://test.local';

describe('RETRYABLE_STATUS_CODES', () => {
    test('includes the standard transient statuses and excludes client error', () => {
        for (const code of [408, 429, 500, 502, 503, 504]) {
            assert.ok(RETRYABLE_STATUS_CODES.has(code), `expected ${code} to be retryable`);
        }
        assert.ok(!RETRYABLE_STATUS_CODES.has(400));
        assert.ok(!RETRYABLE_STATUS_CODES.has(404));
    });
});

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
        const {DEFAULT_RETRY_AFTER_MS} = await import('../../src/config/config.js');
        const response = new Response(null, {headers: {'Retry-After': 'not-a-date'}});
        assert.equal(parseRetryAfterHeader(response), DEFAULT_RETRY_AFTER_MS);
    });
});

describe('fetchJson', () => {
    test('returns parsed JSON on success', async () => {
        intercept({
            origin: ORIGIN,
            path: '/ok',
            status: 200,
            body: {ok: true}
        });

        const data = await fetchJson(`${ORIGIN}/ok`);
        assert.deepEqual(data, {ok: true});
    });

    test('retries a retryable status and eventually succeeds', async () => {
        intercept({origin: ORIGIN, path: '/flaky', status: 503, body: 'busy', times: 1});
        intercept({origin: ORIGIN, path: '/flaky', status: 200, body: {ok: true}, times: 1});

        const data = await fetchJson(`${ORIGIN}/flaky`, {maxRetries: 2});
        assert.deepEqual(data, {ok: true});
        mockAgent.assertNoPendingInterceptors();
    });

    test('throws a transient TrialFetchError after exhausting retries on a retryable status', async () => {
        // maxRetries: 2 means 1 initial attempt + 2 retries = 3 total requests
        intercept({origin: ORIGIN, path: '/fail', status: 500, body: 'error', times: 3});

        await assert.rejects(
            () => fetchJson(`${ORIGIN}/fail`, {maxRetries: 2}),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.status, 500);
                assert.equal(err.isTransient, true);
                return true;
            },
        );
        mockAgent.assertNoPendingInterceptors();
    });

    test('throws a non-transient TrialFetchError immediately on a non-retryable status', async () => {
        intercept({origin: ORIGIN, path: '/bad', status: 400, body: 'nope', times: 1});

        await assert.rejects(
            () => fetchJson(`${ORIGIN}/bad`, {maxRetries: 3}),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.status, 400);
                assert.equal(err.isTransient, false);
                assert.match(err.cause.message, /HTTP 400/);
                return true;
            },
        );
        mockAgent.assertNoPendingInterceptors();
    });

    test('wraps a request that exceeds timeoutMs in a TrialTimeoutError', async () => {
        intercept({origin: ORIGIN, path: '/slow', status: 200, body: {ok: true}, delay: 200});

        await assert.rejects(
            () => fetchJson(`${ORIGIN}/slow`, {timeoutMs: 20, maxRetries: 0}),
            (err) => {
                assert.equal(err.name, 'TrialTimeoutError');
                assert.equal(err.url, `${ORIGIN}/slow`);
                assert.equal(err.timeoutMs, 20);
                return true;
            },
        );
    });

    test('returns null on 404 when allow404 is true', async () => {
        intercept({origin: ORIGIN, path: '/missing', status: 404, body: 'Not Found'});

        const data = await fetchJson(`${ORIGIN}/missing`, {allow404: true});
        assert.equal(data, null);
    });

    test('returns null on 204 No Content', async () => {
        intercept({origin: ORIGIN, path: '/empty', status: 204, body: ''});

        const data = await fetchJson(`${ORIGIN}/empty`);
        assert.equal(data, null);
    });

    test('throws a non-transient TrialFetchError on malformed JSON', async () => {
        intercept({
            origin: ORIGIN,
            path: '/bad-json',
            status: 200,
            body: '{not valid json',
            headers: {'Content-Type': 'application/json'},
        });

        await assert.rejects(
            () => fetchJson(`${ORIGIN}/bad-json`),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.isTransient, false);
                assert.match(err.cause.message, /Invalid JSON/);
                return true;
            },
        );
    });
});

test('attaches proxyUrl to TrialTimeoutError', async () => {
    intercept({
        origin: ORIGIN,
        path: '/slow',
        status: 200,
        body: { ok: true },
        delay: 200,
    });

    await assert.rejects(
        () => fetchJson(`${ORIGIN}/slow`, {
            timeoutMs: 20,
            maxRetries: 0,
        }),
        (err) => {
            assert.equal(err.name, 'TrialTimeoutError');
            assert.equal(err.proxyUrl, 'direct');
            return true;
        },
    );
});

test('attaches proxyUrl to TrialFetchError', async () => {
    intercept({
        origin: ORIGIN,
        path: '/fail',
        status: 500,
        body: 'error',
    });

    await assert.rejects(
        () => fetchJson(`${ORIGIN}/fail`, {
            maxRetries: 0,
        }),
        (err) => {
            assert.equal(err.name, 'TrialFetchError');
            assert.equal(err.proxyUrl, 'direct');
            return true;
        },
    );
});

test('does not mutate AbortError with proxy metadata', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => fetchJson(`${ORIGIN}/ok`, {
            signal: controller.signal,
            maxRetries: 0,
        }),
        (err) => {
            assert.equal(err.name, 'AbortError');
            assert.equal(err.proxyUrl, undefined);
            return true;
        },
    );
});