import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {drainBody, parseJsonResponse} from '../../src/http/responseBody.js';
import {ERROR_BODY_PREVIEW_LENGTH} from '../../src/config/config.js';
import {TrialFetchError} from '../../src/error/errors.js';
import {logger} from "../../src/config/logging.js";

const URL = 'http://test.local/resource';


afterEach(() => {
    jest.restoreAllMocks();
});

describe('drainBody', () => {
    test('cancels a readable body stream', async () => {
        const response = new Response('body', {status: 200});
        const cancelSpy = jest.spyOn(response.body, 'cancel');

        await drainBody(response);

        expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    test('is a no-op when body is null', async () => {
        const response = new Response(null, {status: 204});
        await expect(drainBody(response)).resolves.toBeUndefined();
    });

    test('swallows errors from already-closed bodies', async () => {
        const response = new Response('body', {status: 200});
        await response.body.cancel(); // close first

        await expect(drainBody(response)).resolves.toBeUndefined();
    });
});
test('parses JSON surrounded by whitespace', async () => {
    const response = new Response('\n  {"id":1}\n', {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });

    await expect(parseJsonResponse(response, URL)).resolves.toEqual({id: 1});
});

test('handles empty JSON object body', async () => {
    const response = new Response('{}', {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });

    await expect(parseJsonResponse(response, URL)).resolves.toEqual({});
});

test('logs a warning for unexpected Content-Type', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {
    });

    const response = new Response('{"id":1}', {
        status: 200,
        headers: {
            'Content-Type': 'text/plain',
        },
    });

    await parseJsonResponse(response, URL);

    expect(warnSpy).toHaveBeenCalledWith(
        'Unexpected Content-Type: %s | %s',
        'text/plain',
        URL,
    );
});

test('does not log a warning for application/json', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {
    });

    const response = new Response('{"id":1}', {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });

    await parseJsonResponse(response, URL);

    expect(warnSpy).not.toHaveBeenCalled();
});

test('logs a debug message for 404 responses', async () => {
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {
    });

    const response = new Response('Not Found', {
        status: 404,
    });

    await expect(parseJsonResponse(response, URL)).rejects.toBeInstanceOf(TrialFetchError);

    expect(debugSpy).toHaveBeenCalledWith(
        'HTTP 404 on %s | allow404=%s',
        URL,
        false,
    );
});

test('logs allow404=true when enabled', async () => {
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {
    });

    const response = new Response('Not Found', {
        status: 404,
    });

    await parseJsonResponse(response, URL, {
        allow404: true,
    });

    expect(debugSpy).toHaveBeenCalledWith(
        'HTTP 404 on %s | allow404=%s',
        URL,
        true,
    );
});

test('accepts application/json with charset', async () => {
    const data = {id: 1};

    const response = new Response(JSON.stringify(data), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
        },
    });

    const result = await parseJsonResponse(response, URL);

    expect(result).toEqual(data);
});

test('includes response status in TrialFetchError for invalid JSON', async () => {
    const response = new Response('{', {
        status: 201,
        headers: {
            'Content-Type': 'application/json',
        },
    });

    await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
        status: 201,
        isTransient: false,
    });
});

test('stores request URL in TrialFetchError', async () => {
    const response = new Response('oops', {
        status: 500,
    });

    await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
        url: URL,
    });
});

describe('parseJsonResponse — 404 handling', () => {
    test('returns null on 404 when allow404 is true', async () => {
        const response = new Response('Not Found', {status: 404});
        const result = await parseJsonResponse(response, URL, {allow404: true});

        expect(result).toBe(null);
    });

    test('drains the body on 404 when allow404 is true', async () => {
        const response = new Response('Not Found', {status: 404});
        const cancelSpy = jest.spyOn(response.body, 'cancel');

        await parseJsonResponse(response, URL, {allow404: true});

        expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    test('throws non-transient TrialFetchError on 404 when allow404 is false', async () => {
        const response = new Response('Not Found', {status: 404});

        await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
            status: 404,
            isTransient: false,
            cause: expect.objectContaining({
                message: expect.stringMatching(/HTTP 404.*Not Found/),
            }),
        });
    });

    test('defaults allow404 to false when options are omitted', async () => {
        const response = new Response('Not Found', {status: 404});

        await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
            status: 404,
            isTransient: false,
        });
    });
});

describe('parseJsonResponse — 204 No Content', () => {
    test('returns null on 204 responses', async () => {
        const response = new Response(null, {status: 204});

        await expect(parseJsonResponse(response, URL)).resolves.toBeNull();
    });
});

describe('parseJsonResponse — non-2xx error paths', () => {
    test.each([408, 429, 500, 502, 503, 504])(
        'throws a transient TrialFetchError for HTTP %i',
        async (status) => {
            const response = new Response('error', {status});

            await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
                name: 'TrialFetchError',
                status,
                isTransient: true,
                cause: expect.objectContaining({
                    message: expect.stringMatching(new RegExp(`HTTP ${status}`)),
                }),
            });
        },
    );

    test.each([400, 401, 403, 404, 410, 422])(
        'throws a non-transient TrialFetchError for HTTP %i',
        async (status) => {
            const response = new Response('error', {status});

            await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
                name: 'TrialFetchError',
                status,
                isTransient: false,
            });
        },
    );

    test('truncates error body preview to ERROR_BODY_PREVIEW_LENGTH', async () => {
        const longBody = 'x'.repeat(ERROR_BODY_PREVIEW_LENGTH + 100);
        const response = new Response(longBody, {status: 500});

        const error = await parseJsonResponse(response, URL).catch(err => err);

        expect(error).toBeInstanceOf(TrialFetchError);

        const preview = 'x'.repeat(ERROR_BODY_PREVIEW_LENGTH);

        expect(error.cause.message).toContain(preview);
        expect(error.cause.message).not.toContain(
            'x'.repeat(ERROR_BODY_PREVIEW_LENGTH + 1),
        );
    });

    test('falls back to empty string when response.text() fails', async () => {
        const response = new Response('error', {status: 500});
        response.text = () => Promise.reject(new Error('read failed'));

        const error = await parseJsonResponse(response, URL).catch(err => err);

        expect(error).toBeInstanceOf(TrialFetchError);
        expect(error.name).toBe('TrialFetchError');
        expect(error.status).toBe(500);
        expect(error.isTransient).toBe(true);
        expect(error.cause.message).toMatch(/HTTP 500/);
        expect(error.cause.message).not.toContain('read failed');
    });
});

describe('parseJsonResponse — 2xx success paths', () => {
    test('returns parsed JSON on 200 with application/json', async () => {
        const data = {id: 1, name: 'test'};
        const response = new Response(JSON.stringify(data), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        const result = await parseJsonResponse(response, URL);
        expect(result).toEqual(data);
    });

    test('returns parsed JSON on 201 Created', async () => {
        const data = {created: true};
        const response = new Response(JSON.stringify(data), {
            status: 201,
            headers: {'Content-Type': 'application/json'},
        });

        const result = await parseJsonResponse(response, URL);
        expect(result).toEqual(data);
    });

    test('returns parsed JSON on 2xx with unexpected Content-Type', async () => {
        const data = {id: 1};
        const response = new Response(JSON.stringify(data), {
            status: 200,
            headers: {'Content-Type': 'text/plain'},
        });

        const result = await parseJsonResponse(response, URL);
        expect(result).toEqual(data);
    });

    test('returns parsed JSON on 2xx with missing Content-Type', async () => {
        const data = {id: 1};
        const response = new Response(JSON.stringify(data), {status: 200});

        const result = await parseJsonResponse(response, URL);
        expect(result).toEqual(data);
    });

    test('handles JSON array body', async () => {
        const data = [{id: 1}, {id: 2}];
        const response = new Response(JSON.stringify(data), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });

        const result = await parseJsonResponse(response, URL);
        expect(result).toEqual(data);
    });
});

describe('parseJsonResponse — malformed JSON', () => {
    test('throws non-transient TrialFetchError on invalid JSON', async () => {
        const response = new Response('{not valid json', {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
            name: 'TrialFetchError',
            status: 200,
            isTransient: false,
            cause: expect.objectContaining({
                message: expect.stringMatching(/Invalid JSON/),
            }),
        });
    });

    test('throws non-transient TrialFetchError on empty body with 200', async () => {
        const response = new Response(null, {status: 200});

        await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
            name: 'TrialFetchError',
            status: 200,
            isTransient: false,
            cause: expect.objectContaining({
                message: expect.stringMatching(/Invalid JSON/),
            }),
        });
    });

    test('throws non-transient TrialFetchError on plain text body with 200', async () => {
        const response = new Response('plain text', {status: 200});

        await expect(parseJsonResponse(response, URL)).rejects.toMatchObject({
            name: 'TrialFetchError',
            status: 200,
            isTransient: false,
        });
    });
});