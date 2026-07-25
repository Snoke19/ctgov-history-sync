import {describe, jest, test} from '@jest/globals';
import assert from 'node:assert/strict';
import {drainBody, parseJsonResponse} from '../../src/http/responseBody.js';
import {ERROR_BODY_PREVIEW_LENGTH} from '../../src/config/config.js';
import {TrialFetchError} from '../../src/error/errors.js';

const URL = 'http://test.local/resource';

// =============================================================================
// drainBody
// =============================================================================

describe('drainBody', () => {
    test('cancels a readable body stream', async () => {
        const response = new Response('body', {status: 200});
        const cancelSpy = jest.spyOn(response.body, 'cancel');

        await drainBody(response);

        assert.equal(cancelSpy.mock.calls.length, 1);
        cancelSpy.mockRestore();
    });

    test('is a no-op when body is null', async () => {
        const response = new Response(null, {status: 204});
        await assert.doesNotReject(() => drainBody(response));
    });

    test('swallows errors from already-closed bodies', async () => {
        const response = new Response('body', {status: 200});
        await response.body.cancel(); // close first

        await assert.doesNotReject(() => drainBody(response));
    });
});

// =============================================================================
// parseJsonResponse — 404 handling
// =============================================================================

describe('parseJsonResponse — 404 handling', () => {
    test('returns null on 404 when allow404 is true', async () => {
        const response = new Response('Not Found', {status: 404});
        const result = await parseJsonResponse(response, URL, {allow404: true});

        assert.equal(result, null);
    });

    test('drains the body on 404 when allow404 is true', async () => {
        const response = new Response('Not Found', {status: 404});
        const cancelSpy = jest.spyOn(response.body, 'cancel');

        await parseJsonResponse(response, URL, {allow404: true});

        assert.equal(cancelSpy.mock.calls.length, 1);
        cancelSpy.mockRestore();
    });

    test('throws non-transient TrialFetchError on 404 when allow404 is false', async () => {
        const response = new Response('Not Found', {status: 404});

        await assert.rejects(
            () => parseJsonResponse(response, URL),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.status, 404);
                assert.equal(err.isTransient, false);
                assert.match(err.cause.message, /HTTP 404/);
                assert.match(err.cause.message, /Not Found/);
                return true;
            },
        );
    });

    test('defaults allow404 to false when options omitted', async () => {
        const response = new Response('Not Found', {status: 404});

        await assert.rejects(
            () => parseJsonResponse(response, URL),
            (err) => {
                assert.equal(err.status, 404);
                return true;
            },
        );
    });
});

// =============================================================================
// parseJsonResponse — 204 No Content
// =============================================================================

describe('parseJsonResponse — 204 No Content', () => {
    test('returns null on 204', async () => {
        const response = new Response(null, {status: 204});
        const result = await parseJsonResponse(response, URL);

        assert.equal(result, null);
    });

    test('drains the body on 204', async () => {
        const response = new Response(null, {status: 204});
        // Body is null for 204, so drainBody should be a no-op.
        await assert.doesNotReject(() => parseJsonResponse(response, URL));
    });
});

// =============================================================================
// parseJsonResponse — non-2xx error paths
// =============================================================================

describe('parseJsonResponse — non-2xx error paths', () => {
    test('throws transient TrialFetchError on retryable statuses', async () => {
        for (const code of [408, 429, 500, 502, 503, 504]) {
            const response = new Response('error', {status: code});

            await assert.rejects(
                () => parseJsonResponse(response, URL),
                (err) => {
                    assert.equal(err.name, 'TrialFetchError');
                    assert.equal(err.status, code);
                    assert.equal(err.isTransient, true);
                    assert.match(err.cause.message, new RegExp(`HTTP ${code}`));
                    return true;
                },
            );
        }
    });

    test('throws non-transient TrialFetchError on non-retryable statuses', async () => {
        for (const code of [400, 401, 403, 404, 410, 422]) {
            const response = new Response('error', {status: code});

            await assert.rejects(
                () => parseJsonResponse(response, URL),
                (err) => {
                    assert.equal(err.name, 'TrialFetchError');
                    assert.equal(err.status, code);
                    assert.equal(err.isTransient, false);
                    return true;
                },
            );
        }
    });

    test('truncates error body preview to ERROR_BODY_PREVIEW_LENGTH', async () => {
        const longBody = 'x'.repeat(ERROR_BODY_PREVIEW_LENGTH + 100);
        const response = new Response(longBody, {status: 500});

        await assert.rejects(
            () => parseJsonResponse(response, URL),
            (err) => {
                const preview = 'x'.repeat(ERROR_BODY_PREVIEW_LENGTH);
                assert.ok(err.cause.message.includes(preview));
                assert.ok(!err.cause.message.includes('x'.repeat(ERROR_BODY_PREVIEW_LENGTH + 1)));
                return true;
            },
        );
    });

    test('falls back to empty string when response.text() fails', async () => {
        const response = new Response('error', {status: 500});
        response.text = () => Promise.reject(new Error('read failed'));

        await assert.rejects(
            () => parseJsonResponse(response, URL),
            (err) => {
                assert.equal(err.status, 500);
                assert.equal(err.isTransient, true);
                assert.match(err.cause.message, /HTTP 500/);
                assert.ok(!err.cause.message.includes('read failed'));
                return true;
            },
        );
    });
});

// =============================================================================
// parseJsonResponse — 2xx success paths
// =============================================================================

describe('parseJsonResponse — 2xx success paths', () => {
    test('returns parsed JSON on 200 with application/json', async () => {
        const data = {id: 1, name: 'test'};
        const response = new Response(JSON.stringify(data), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        const result = await parseJsonResponse(response, URL);
        assert.deepEqual(result, data);
    });

    test('returns parsed JSON on 201 Created', async () => {
        const data = {created: true};
        const response = new Response(JSON.stringify(data), {
            status: 201,
            headers: {'Content-Type': 'application/json'},
        });

        const result = await parseJsonResponse(response, URL);
        assert.deepEqual(result, data);
    });

    test('returns parsed JSON on 2xx with unexpected Content-Type', async () => {
        const data = {id: 1};
        const response = new Response(JSON.stringify(data), {
            status: 200,
            headers: {'Content-Type': 'text/plain'},
        });

        const result = await parseJsonResponse(response, URL);
        assert.deepEqual(result, data);
    });

    test('returns parsed JSON on 2xx with missing Content-Type', async () => {
        const data = {id: 1};
        const response = new Response(JSON.stringify(data), {status: 200});

        const result = await parseJsonResponse(response, URL);
        assert.deepEqual(result, data);
    });

    test('handles JSON array body', async () => {
        const data = [{id: 1}, {id: 2}];
        const response = new Response(JSON.stringify(data), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        const result = await parseJsonResponse(response, URL);
        assert.deepEqual(result, data);
    });

    test('handles empty JSON object body', async () => {
        const response = new Response('{}', {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        const result = await parseJsonResponse(response, URL);
        assert.deepEqual(result, {});
    });
});

// =============================================================================
// parseJsonResponse — malformed JSON
// =============================================================================

describe('parseJsonResponse — malformed JSON', () => {
    test('throws non-transient TrialFetchError on invalid JSON', async () => {
        const response = new Response('{not valid json', {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        await assert.rejects(
            () => parseJsonResponse(response, URL),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.status, 200);
                assert.equal(err.isTransient, false);
                assert.match(err.cause.message, /Invalid JSON/);
                return true;
            },
        );
    });

    test('throws non-transient TrialFetchError on empty body with 200', async () => {
        const response = new Response(null, {status: 200});

        await assert.rejects(
            () => parseJsonResponse(response, URL),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.isTransient, false);
                assert.match(err.cause.message, /Invalid JSON/);
                return true;
            },
        );
    });

    test('throws non-transient TrialFetchError on plain text body with 200', async () => {
        const response = new Response('plain text', {status: 200});

        await assert.rejects(
            () => parseJsonResponse(response, URL),
            (err) => {
                assert.equal(err.name, 'TrialFetchError');
                assert.equal(err.isTransient, false);
                return true;
            },
        );
    });
});