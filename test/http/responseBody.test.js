import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {drainBody, parseJsonResponse} from '../../src/http/responseBody.js';
import {ERROR_BODY_PREVIEW_LENGTH} from '../../src/config/config.js';
import {TrialFetchError} from '../../src/error/errors.js';
import {logger} from '../../src/config/logging.js';

const TEST_URL = 'http://test.local/resource';

describe('responseBody.js', () => {
    let debugSpy;
    let warnSpy;

    beforeEach(() => {
        debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
        warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

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

        test('is a no-op when response body is null', async () => {
            const response = new Response(null, {status: 204});

            await expect(drainBody(response)).resolves.toBeUndefined();
        });

        test('is a no-op when response body is undefined', async () => {
            const response = {body: undefined};

            await expect(drainBody(response)).resolves.toBeUndefined();
        });

        test('swallows errors when response.body.cancel() succeeds on closed body', async () => {
            const response = new Response('body', {status: 200});
            await response.body.cancel(); // close first

            await expect(drainBody(response)).resolves.toBeUndefined();
        });

        test('swallows errors when response.body.cancel() throws or rejects', async () => {
            const response = {
                body: {
                    cancel: jest.fn().mockRejectedValue(new Error('Stream cancel error')),
                },
            };

            await expect(drainBody(response)).resolves.toBeUndefined();
            expect(response.body.cancel).toHaveBeenCalledTimes(1);
        });
    });

    describe('parseJsonResponse', () => {
        describe('2xx Success Paths', () => {
            test('returns parsed JSON object on 200 OK with application/json', async () => {
                const data = {id: 1, name: 'test'};
                const response = new Response(JSON.stringify(data), {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });

                const result = await parseJsonResponse(response, TEST_URL);

                expect(result).toEqual(data);
            });

            test('returns parsed JSON object on 201 Created', async () => {
                const data = {created: true};
                const response = new Response(JSON.stringify(data), {
                    status: 201,
                    headers: {'Content-Type': 'application/json'},
                });

                const result = await parseJsonResponse(response, TEST_URL);

                expect(result).toEqual(data);
            });

            test('handles JSON surrounded by leading and trailing whitespace', async () => {
                const response = new Response('\n  {"id":1}\n', {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });

                await expect(parseJsonResponse(response, TEST_URL)).resolves.toEqual({id: 1});
            });

            test('handles empty JSON object body', async () => {
                const response = new Response('{}', {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });

                await expect(parseJsonResponse(response, TEST_URL)).resolves.toEqual({});
            });

            test('handles JSON array body', async () => {
                const data = [{id: 1}, {id: 2}];
                const response = new Response(JSON.stringify(data), {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });

                const result = await parseJsonResponse(response, TEST_URL);

                expect(result).toEqual(data);
            });

            test('handles JSON primitive values (number, boolean, string, null)', async () => {
                const primitives = [123, true, 'hello', null];

                for (const value of primitives) {
                    const response = new Response(JSON.stringify(value), {
                        status: 200,
                        headers: {'Content-Type': 'application/json'},
                    });
                    const result = await parseJsonResponse(response, TEST_URL);

                    expect(result).toEqual(value);
                }
            });
        });

        describe('204 No Content', () => {
            test('returns null on 204 responses', async () => {
                const response = new Response(null, {status: 204});

                await expect(parseJsonResponse(response, TEST_URL)).resolves.toBeNull();
            });

            test('drains body stream on 204 responses when body is present', async () => {
                const response = {
                    status: 204,
                    body: {
                        cancel: jest.fn().mockResolvedValue(),
                    },
                };

                const result = await parseJsonResponse(response, TEST_URL);

                expect(result).toBeNull();
                expect(response.body.cancel).toHaveBeenCalledTimes(1);
            });
        });

        describe('404 Handling & allow404 Option', () => {
            test('returns null on 404 when allow404 is true', async () => {
                const response = new Response('Not Found', {status: 404});

                const result = await parseJsonResponse(response, TEST_URL, {allow404: true});

                expect(result).toBeNull();
            });

            test('drains body stream on 404 when allow404 is true', async () => {
                const response = new Response('Not Found', {status: 404});
                const cancelSpy = jest.spyOn(response.body, 'cancel');

                await parseJsonResponse(response, TEST_URL, {allow404: true});

                expect(cancelSpy).toHaveBeenCalledTimes(1);
            });

            test('logs debug message with allow404=true when enabled', async () => {
                const response = new Response('Not Found', {status: 404});

                await parseJsonResponse(response, TEST_URL, {allow404: true});

                expect(debugSpy).toHaveBeenCalledWith(
                    'HTTP 404 on %s | allow404=%s',
                    TEST_URL,
                    true,
                );
            });

            test('logs debug message with allow404=false when disabled', async () => {
                const response = new Response('Not Found', {status: 404});

                await expect(parseJsonResponse(response, TEST_URL)).rejects.toBeInstanceOf(
                    TrialFetchError,
                );

                expect(debugSpy).toHaveBeenCalledWith(
                    'HTTP 404 on %s | allow404=%s',
                    TEST_URL,
                    false,
                );
            });

            test('throws non-transient TrialFetchError on 404 when allow404 is false', async () => {
                const response = new Response('Not Found', {status: 404});

                await expect(parseJsonResponse(response, TEST_URL, {allow404: false})).rejects.toMatchObject({
                    name: 'TrialFetchError',
                    status: 404,
                    isTransient: false,
                    url: TEST_URL,
                    cause: expect.objectContaining({
                        message: expect.stringMatching(/HTTP 404.*Not Found/),
                    }),
                });
            });

            test('defaults allow404 to false when options parameter is omitted', async () => {
                const response = new Response('Not Found', {status: 404});

                await expect(parseJsonResponse(response, TEST_URL)).rejects.toMatchObject({
                    status: 404,
                    isTransient: false,
                });
            });
        });

        describe('Content-Type Header Handling & Logging', () => {
            test('does not log warning for application/json', async () => {
                const response = new Response('{"id":1}', {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });

                await parseJsonResponse(response, TEST_URL);

                expect(warnSpy).not.toHaveBeenCalled();
            });

            test('does not log warning for application/json with charset', async () => {
                const response = new Response('{"id":1}', {
                    status: 200,
                    headers: {'Content-Type': 'application/json; charset=utf-8'},
                });

                await parseJsonResponse(response, TEST_URL);

                expect(warnSpy).not.toHaveBeenCalled();
            });

            test('logs warning for unexpected Content-Type text/plain', async () => {
                const response = new Response('{"id":1}', {
                    status: 200,
                    headers: {'Content-Type': 'text/plain'},
                });

                await parseJsonResponse(response, TEST_URL);

                expect(warnSpy).toHaveBeenCalledWith(
                    'Unexpected Content-Type: %s | %s',
                    'text/plain',
                    TEST_URL,
                );
            });

            test('logs warning for missing Content-Type header (null fallback to empty string)', async () => {
                const response = {
                    status: 200,
                    ok: true,
                    headers: {get: () => null},
                    json: async () => ({id: 1}),
                };

                const result = await parseJsonResponse(response, TEST_URL);

                expect(result).toEqual({id: 1});
                expect(warnSpy).toHaveBeenCalledWith(
                    'Unexpected Content-Type: %s | %s',
                    '',
                    TEST_URL,
                );
            });
        });

        describe('Non-2xx HTTP Error Paths & Retryability', () => {
            test.each([408, 429, 500, 502, 503, 504])(
                'throws a transient TrialFetchError for retryable status HTTP %i',
                async (status) => {
                    const response = new Response('server error', {status});

                    await expect(parseJsonResponse(response, TEST_URL)).rejects.toMatchObject({
                        name: 'TrialFetchError',
                        status,
                        isTransient: true,
                        url: TEST_URL,
                        cause: expect.objectContaining({
                            message: expect.stringMatching(new RegExp(`HTTP ${status}`)),
                        }),
                    });
                },
            );

            test.each([400, 401, 403, 404, 410, 422])(
                'throws a non-transient TrialFetchError for non-retryable status HTTP %i',
                async (status) => {
                    const response = new Response('client error', {status});

                    await expect(parseJsonResponse(response, TEST_URL)).rejects.toMatchObject({
                        name: 'TrialFetchError',
                        status,
                        isTransient: false,
                        url: TEST_URL,
                    });
                },
            );

            test('truncates error body preview to ERROR_BODY_PREVIEW_LENGTH', async () => {
                const longBody = 'x'.repeat(ERROR_BODY_PREVIEW_LENGTH + 100);
                const response = new Response(longBody, {status: 500});

                const error = await parseJsonResponse(response, TEST_URL).catch((err) => err);

                expect(error).toBeInstanceOf(TrialFetchError);
                const preview = 'x'.repeat(ERROR_BODY_PREVIEW_LENGTH);
                expect(error.cause.message).toContain(preview);
                expect(error.cause.message).not.toContain('x'.repeat(ERROR_BODY_PREVIEW_LENGTH + 1));
            });

            test('falls back to empty string when response.text() fails/rejects', async () => {
                const response = new Response('error', {status: 500});
                response.text = () => Promise.reject(new Error('Stream read failed'));

                const error = await parseJsonResponse(response, TEST_URL).catch((err) => err);

                expect(error).toBeInstanceOf(TrialFetchError);
                expect(error.status).toBe(500);
                expect(error.isTransient).toBe(true);
                expect(error.cause.message).toMatch(/HTTP 500/);
                expect(error.cause.message).not.toContain('Stream read failed');
            });
        });

        describe('Malformed JSON & Parsing Errors', () => {
            test('throws non-transient TrialFetchError on invalid JSON syntax', async () => {
                const response = new Response('{invalid json', {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });

                await expect(parseJsonResponse(response, TEST_URL)).rejects.toMatchObject({
                    name: 'TrialFetchError',
                    status: 200,
                    isTransient: false,
                    url: TEST_URL,
                    cause: expect.objectContaining({
                        message: expect.stringMatching(/Invalid JSON/),
                    }),
                });
            });

            test('throws non-transient TrialFetchError on empty body with status 200', async () => {
                const response = new Response(null, {status: 200});

                await expect(parseJsonResponse(response, TEST_URL)).rejects.toMatchObject({
                    name: 'TrialFetchError',
                    status: 200,
                    isTransient: false,
                    cause: expect.objectContaining({
                        message: expect.stringMatching(/Invalid JSON/),
                    }),
                });
            });

            test('throws non-transient TrialFetchError on plain text body with status 200', async () => {
                const response = new Response('plain text string', {status: 200});

                await expect(parseJsonResponse(response, TEST_URL)).rejects.toMatchObject({
                    name: 'TrialFetchError',
                    status: 200,
                    isTransient: false,
                });
            });
        });
    });
});