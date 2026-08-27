import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
    CallerAbortedError,
    EndpointAcquisitionTimeoutError,
    HttpException,
    NetworkException,
    TimeoutException,
    TrialError,
    UnexpectedError,
} from '../../../src/error/errors.js';
import { EndpointHandle } from '../../../src/http/endpoint/endpoint.js';
import { HttpResponse } from '../../../src/http/transport/httpTransport.js';
import { FetchOperation } from '../../../src/retry/fetchOperation.js';
import { createMockEndpoint, createMockEndpointManager } from '../fixtures/endpoint.fixture.js';
import { createMockTransport } from '../fixtures/transport.fixture.js';

const URL = 'https://example.com/trials?apiKey=secret-token&page=2';
const USER_AGENT = 'TestAgent/1.0';
const DEFAULT_TIMEOUT_MS = 1_000;

function createResponse(
    options: {
        ok?: boolean;
        status?: number;
        statusText?: string;
        headers?: Record<string, string>;
        discard?: jest.Mock<() => Promise<void>>;
        json?: jest.Mock<() => Promise<unknown>>;
        text?: jest.Mock<() => Promise<string>>;
    } = {},
): HttpResponse {
    return {
        ok: options.ok ?? true,
        status: options.status ?? 200,
        statusText: options.statusText ?? 'OK',
        headers: new Headers(options.headers),
        discard: options.discard ?? jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        json: options.json ?? jest.fn<() => Promise<unknown>>().mockResolvedValue({ ok: true }),
        text: options.text ?? jest.fn<() => Promise<string>>().mockResolvedValue(''),
    };
}

function rejectOnAbort(
    signal: AbortSignal,
    reject: (reason?: unknown) => void,
    error: unknown = new Error('The operation was aborted.'),
): void {
    if (signal.aborted) {
        reject(error);
        return;
    }

    signal.addEventListener('abort', () => reject(error), { once: true });
}

function createOperationFixture(
    transportOptions: {
        headers?: Record<string, string>;
        signal?: AbortSignal;
        timeoutMs?: number;
    } = {},
    url = URL,
    now?: () => number,
) {
    const transport = createMockTransport();
    const endpoint = createMockEndpoint(transport);
    const { manager, acquireEndpoint } = createMockEndpointManager(endpoint);

    const operation = new FetchOperation(
        manager,
        url,
        transportOptions,
        {
            timeoutMs: DEFAULT_TIMEOUT_MS,
            userAgent: USER_AGENT,
        },
        now,
    );

    return {
        transport,
        endpoint,
        endpointManager: manager,
        acquireEndpoint,
        operation,
    };
}

describe('FetchOperation', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('uses the operation timeout instead of the default timeout', async () => {
        const timeoutMs = 250;
        const { transport, operation } = createOperationFixture({
            timeoutMs,
        });

        const transportAbortError = new Error('The operation was aborted.');
        transport.request.mockImplementation((options) => {
            return new Promise<HttpResponse>((_, reject) => {
                rejectOnAbort(options.signal, reject, transportAbortError);
            });
        });

        const promise = operation.perform();
        const rejection = promise.catch((error: unknown) => error);

        await jest.advanceTimersByTimeAsync(timeoutMs - 1);
        expect(transport.request).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        const error = await rejection;
        expect(error).toBeInstanceOf(TimeoutException);
        expect((error as TimeoutException).message).toContain(`Request timed out after ${timeoutMs}ms`);
    });

    describe('successful requests', () => {
        it('returns the successful response', async () => {
            const { transport, operation, endpointManager } = createOperationFixture();
            const response = createResponse();
            transport.request.mockResolvedValue(response);

            await expect(operation.perform()).resolves.toBe(response);

            expect(endpointManager.acquireEndpoint).toHaveBeenCalledTimes(1);
            expect(endpointManager.acquireEndpoint).toHaveBeenCalledWith(expect.any(AbortSignal));
            expect(transport.request).toHaveBeenCalledTimes(1);
        });

        it('uses GET and passes the operation abort signal to transport', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(transport.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: URL,
                    method: 'GET',
                    signal: expect.any(AbortSignal),
                }),
            );
        });

        it('uses default headers', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(createResponse());
            
            await operation.perform();

            expect(transport.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': USER_AGENT,
                    },
                }),
            );
        });

        it('allows caller headers to override defaults', async () => {
            const { transport, operation } = createOperationFixture({
                headers: {
                    Accept: 'application/xml',
                    'X-Test': 'true',
                },
            });
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(transport.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: {
                        Accept: 'application/xml',
                        'User-Agent': USER_AGENT,
                        'X-Test': 'true',
                    },
                }),
            );
        });

        it.each(['accept', 'ACCEPT', 'Accept'])('canonicalizes the %s Accept header', async (headerName) => {
            const { transport, operation } = createOperationFixture({
                headers: {
                    [headerName]: 'application/xml',
                },
            });
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(transport.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: {
                        Accept: 'application/xml',
                        'User-Agent': USER_AGENT,
                    },
                }),
            );
        });

        it.each(['user-agent', 'USER-AGENT', 'User-Agent'])(
            'canonicalizes the %s User-Agent header',
            async (headerName) => {
                const { transport, operation } = createOperationFixture({
                    headers: {
                        [headerName]: 'OverrideAgent/2.0',
                    },
                });
                transport.request.mockResolvedValue(createResponse());

                await operation.perform();

                expect(transport.request).toHaveBeenCalledWith(
                    expect.objectContaining({
                        headers: {
                            Accept: 'application/json',
                            'User-Agent': 'OverrideAgent/2.0',
                        },
                    }),
                );
            },
        );

        it('preserves arbitrary caller headers unchanged', async () => {
            const { transport, operation } = createOperationFixture({
                headers: {
                    'X-Request-ID': 'request-123',
                    'X-Custom-Header': 'custom-value',
                },
            });
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(transport.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': USER_AGENT,
                        'X-Request-ID': 'request-123',
                        'X-Custom-Header': 'custom-value',
                    },
                }),
            );
        });
    });

    describe('endpoint acquisition', () => {
        it('propagates an unexpected endpoint acquisition error unchanged', async () => {
            const originalError = new Error('endpoint provider failed');
            const { operation, acquireEndpoint } = createOperationFixture();
            acquireEndpoint.mockRejectedValue(originalError);

            await expect(operation.perform()).rejects.toBe(originalError);
        });

        it('converts EndpointAcquisitionTimeoutError into TimeoutException', async () => {
            const { operation, acquireEndpoint } = createOperationFixture();
            acquireEndpoint.mockRejectedValue(new EndpointAcquisitionTimeoutError(2_500, 5));

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'TimeoutException',
                message: expect.stringContaining('Endpoint acquisition timed out after 2500ms'),
                cause: expect.any(EndpointAcquisitionTimeoutError),
            });
        });

        it('does not start the request timeout before endpoint acquisition completes', async () => {
            const { transport, operation, acquireEndpoint } = createOperationFixture({
                timeoutMs: 1_000,
            });
            transport.request.mockResolvedValue(createResponse());
            let resolveAcquisition!: (endpoint: EndpointHandle) => void;
            const acquisition = new Promise<EndpointHandle>((resolve) => {
                resolveAcquisition = resolve;
            });
            acquireEndpoint.mockReturnValue(acquisition);

            const promise = operation.perform();
            await jest.advanceTimersByTimeAsync(1_000);

            expect(transport.request).not.toHaveBeenCalled();
            const endpoint = createMockEndpoint(transport);
            resolveAcquisition(endpoint.getHandle());
            await promise;
            expect(transport.request).toHaveBeenCalledTimes(1);
        });

        it('prioritizes caller cancellation over endpoint acquisition timeout', async () => {
            const controller = new AbortController();
            const { operation, acquireEndpoint } = createOperationFixture({
                signal: controller.signal,
                timeoutMs: 1_000,
            });
            acquireEndpoint.mockImplementation(async () => {
                controller.abort();
                throw new EndpointAcquisitionTimeoutError(1_000, 1);
            });

            await expect(operation.perform()).rejects.toBeInstanceOf(CallerAbortedError);
        });
    });

    describe('caller cancellation', () => {
        it('throws CallerAbortedError when the caller signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();
            const { transport, endpoint, operation, acquireEndpoint } = createOperationFixture({
                signal: controller.signal,
            });

            acquireEndpoint.mockImplementation(async (signal) => {
                if (signal.aborted) {
                    throw new CallerAbortedError();
                }
                return endpoint.getHandle();
            });

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(acquireEndpoint).toHaveBeenCalledWith(expect.any(AbortSignal));
            expect(transport.request).not.toHaveBeenCalled();
        });

        it('converts an existing CallerAbortedError into the operation-level caller error', async () => {
            const originalError = new CallerAbortedError('endpoint acquisition was cancelled');
            const { operation, acquireEndpoint } = createOperationFixture();
            acquireEndpoint.mockRejectedValue(originalError);

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error).not.toBe(originalError);
            expect((error as CallerAbortedError).message).toContain('Request cancelled by caller');
            expect((error as CallerAbortedError).cause).toBe(originalError);
        });

        it('throws CallerAbortedError when the caller aborts during the request', async () => {
            const transportAbortError = new Error('The operation was aborted.');
            const controller = new AbortController();
            const { transport, operation } = createOperationFixture({
                signal: controller.signal,
            });
            transport.request.mockImplementation((options) => {
                return new Promise<HttpResponse>((_, reject) => {
                    rejectOnAbort(options.signal, reject, transportAbortError);
                });
            });
            transport.classifyError.mockReturnValue({
                kind: 'cancelled',
                cause: transportAbortError,
            });

            const promise = operation.perform();

            controller.abort();

            await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);
        });

        it('prioritizes caller cancellation over the internal timeout', async () => {
            const controller = new AbortController();
            const transportAbortError = new Error('The operation was aborted.');

            const { transport, operation } = createOperationFixture({
                signal: controller.signal,
                timeoutMs: DEFAULT_TIMEOUT_MS,
            });
            transport.request.mockImplementation((options) => {
                return new Promise<HttpResponse>((_, reject) => {
                    rejectOnAbort(options.signal, reject, transportAbortError);
                });
            });

            const promise = operation.perform();
            const rejection = promise.catch((error: unknown) => error);

            controller.abort();

            await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
            const error = await rejection;
            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(transport.classifyError).not.toHaveBeenCalled();
        });
    });

    describe('transport error classification', () => {
        it('passes TrialError through unchanged', async () => {
            const original = new TrialError('already classified');
            const { transport, operation } = createOperationFixture();

            transport.request.mockRejectedValue(original);

            await expect(operation.perform()).rejects.toBe(original);
            expect(transport.classifyError).not.toHaveBeenCalled();
        });

        it('converts a transport timeout into TimeoutException', async () => {
            const cause = new Error('headers timeout');
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(new Error('transport failure'));
            transport.classifyError.mockReturnValue({
                kind: 'timeout',
                cause,
            });

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'TimeoutException',
                cause,
                message: expect.stringContaining('headers timeout'),
            });
        });

        it('converts a network failure into NetworkException', async () => {
            const cause = Object.assign(new Error('connection reset'), {
                code: 'ECONNRESET',
            });
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(new Error('transport failure'));
            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause,
            });

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'NetworkException',
                cause,
                message: expect.stringContaining('ECONNRESET'),
            });
        });

        it('converts an unknown transport failure into UnexpectedError', async () => {
            const cause = new Error('unexpected transport state');
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(cause);
            transport.classifyError.mockReturnValue({
                kind: 'unknown',
                cause,
            });

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'UnexpectedError',
                cause,
            });
        });

        it('does not turn unknown transport cancellation into CallerAbortedError', async () => {
            const cause = new Error('transport cancelled itself');
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(cause);
            transport.classifyError.mockReturnValue({
                kind: 'cancelled',
                cause,
            });

            await expect(operation.perform()).rejects.toBeInstanceOf(UnexpectedError);
        });

        it('preserves a transport timeout when no AbortController reason is present', async () => {
            const cause = new Error('socket timeout');
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(cause);
            transport.classifyError.mockReturnValue({
                kind: 'timeout',
                cause,
            });

            await expect(operation.perform()).rejects.toBeInstanceOf(TimeoutException);
        });
    });

    describe('HTTP responses', () => {
        it('preserves HttpException when response body draining fails', async () => {
            const discardError = new Error('discard failed');
            const discard = jest.fn<() => Promise<void>>().mockRejectedValue(discardError);

            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    discard,
                }),
            );

            const error = await operation.perform().catch((value: unknown) => value);
            expect(discard).toHaveBeenCalledTimes(1);
            expect(error).toBeInstanceOf(HttpException);
            expect((error as HttpException).status).toBe(503);
        });

        it('extracts Retry-After HTTP-date into HttpException', async () => {
            const now = Date.parse('2026-08-26T12:00:00.000Z');
            const retryAt = new Date(now + 30_000).toUTCString();

            const { transport, operation } = createOperationFixture({}, URL, () => now);
            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: {
                        'Retry-After': retryAt,
                    },
                }),
            );

            const error = await operation.perform().catch((value: unknown) => value);
            expect(error).toBeInstanceOf(HttpException);
            expect((error as HttpException).status).toBe(429);
            expect((error as HttpException).retryAfterMs).toBe(30_000);
        });

        it.each([
            [400, 'Bad Request'],
            [404, 'Not Found'],
            [500, 'Internal Server Error'],
            [503, 'Service Unavailable'],
        ])('throws HttpException for HTTP %s responses', async (status, statusText) => {
            const discard = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status,
                    statusText,
                    discard,
                }),
            );

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'HttpException',
                status,
                message: expect.stringContaining(`HTTP ${status} ${statusText}`),
            });

            expect(discard).toHaveBeenCalledTimes(1);
        });

        it('extracts Retry-After delay-seconds into HttpException', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: {
                        'Retry-After': '12',
                    },
                }),
            );

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(HttpException);
            expect(error).toMatchObject({
                status: 503,
                retryAfterMs: 12_000,
            });
        });

        it('sets Retry-After to undefined when the header is malformed', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: {
                        'Retry-After': 'not-a-valid-delay',
                    },
                }),
            );

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(HttpException);
            expect(error).toMatchObject({
                status: 503,
                retryAfterMs: undefined,
            });
        });
    });

    describe('URL sanitization', () => {
        it('does not expose credentials from URL userinfo', async () => {
            const { transport, operation } = createOperationFixture(
                {},
                'https://username:super-secret@example.com/trials?token=secret',
            );

            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                }),
            );

            await expect(operation.perform()).rejects.toMatchObject({
                message: expect.stringContaining('https://example.com/trials'),
            });
        });

        it('uses a safe placeholder for an invalid URL', async () => {
            const { transport, operation } = createOperationFixture({}, 'not a valid url');
            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                }),
            );

            await expect(operation.perform()).rejects.toMatchObject({
                message: expect.stringContaining('<invalid URL>'),
            });
        });
    });

    describe('error messages', () => {
        it('bounds a long Error message', async () => {
            const { transport, operation } = createOperationFixture();
            const longMessage = 'x'.repeat(1_000);
            const cause = new Error(longMessage);
            transport.request.mockRejectedValue(cause);
            transport.classifyError.mockReturnValue({ kind: 'network', cause });

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(NetworkException);
            const message = (error as NetworkException).message;
            expect(message.length).toBeLessThan(400);
            expect(message).toContain('xxxxxxxx');
            expect(message).toContain('…');
        });

        it('bounds a long string transport cause', async () => {
            const longCause = 'connection failed '.repeat(100);
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(longCause);
            transport.classifyError.mockReturnValue({ kind: 'network', cause: longCause });

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(NetworkException);
            const message = (error as NetworkException).message;
            expect(message).toContain('Network failure:');
            expect(message).toContain('…');
            expect(message.length).toBeLessThan(400);
        });

        it('includes a string transport cause without throwing while formatting the error', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue('connection failed');
            transport.classifyError.mockReturnValue({ kind: 'network', cause: 'connection failed' });

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(NetworkException);
            expect((error as NetworkException).message).toContain('connection failed');
        });

        it('does not expose sensitive fields from an arbitrary transport cause', async () => {
            const sensitiveCause = {
                message: 'connection failed',
                username: 'admin',
                password: 'super-secret-password',
                token: 'super-secret-token',
            };
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(sensitiveCause);
            transport.classifyError.mockReturnValue({ kind: 'network', cause: sensitiveCause });

            const error = await operation.perform().catch((value: unknown) => value);
            expect(error).toBeInstanceOf(NetworkException);
            const message = (error as NetworkException).message;
            expect(message).toContain('https://example.com/trials');
            expect(message).not.toContain('super-secret-password');
            expect(message).not.toContain('super-secret-token');
        });
    });

    describe('request timeout', () => {
        it('clears the request timeout after a successful request', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(jest.getTimerCount()).toBe(0);
        });

        it('clears the request timeout after a failed request', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(new Error('network down'));
            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause: new Error('ECONNRESET'),
            });

            await expect(operation.perform()).rejects.toBeInstanceOf(NetworkException);

            expect(jest.getTimerCount()).toBe(0);
        });

        it('removes the caller abort listener after completion', async () => {
            const controller = new AbortController();
            const addSpy = jest.spyOn(controller.signal, 'addEventListener');
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
            const { transport, operation } = createOperationFixture({
                signal: controller.signal,
            });
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        it('removes the caller abort listener when the request fails', async () => {
            const controller = new AbortController();
            const addSpy = jest.spyOn(controller.signal, 'addEventListener');
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');

            const { transport, operation } = createOperationFixture({
                signal: controller.signal,
            });
            transport.request.mockRejectedValue(new Error('network down'));
            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause: new Error('ECONNRESET'),
            });

            await expect(operation.perform()).rejects.toBeInstanceOf(NetworkException);
            expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
        });
    });

    describe('abort and timeout cleanup', () => {
        it('throws TimeoutException when the internal request timeout aborts the transport', async () => {
            const transportAbortError = new Error('The operation was aborted.');
            const { transport, operation } = createOperationFixture({
                timeoutMs: DEFAULT_TIMEOUT_MS,
            });
            transport.request.mockImplementation((options) => {
                return new Promise<HttpResponse>((_, reject) => {
                    rejectOnAbort(options.signal, reject, transportAbortError);
                });
            });

            const promise = operation.perform();
            const rejection = promise.catch((error: unknown) => error);

            await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
            const error = await rejection;
            expect(error).toBeInstanceOf(TimeoutException);
            const timeoutError = error as TimeoutException;
            expect(timeoutError.message).toContain(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
            expect(timeoutError.cause).toBe(transportAbortError);
            expect(transport.classifyError).not.toHaveBeenCalled();
        });

        it('clears the request timeout after a successful request', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(jest.getTimerCount()).toBe(0);
        });

        it('clears the request timeout after a failed request', async () => {
            const { transport, operation } = createOperationFixture();
            transport.request.mockRejectedValue(new Error('network down'));
            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause: new Error('ECONNRESET'),
            });

            await expect(operation.perform()).rejects.toBeInstanceOf(NetworkException);

            expect(jest.getTimerCount()).toBe(0);
        });

        it('removes the caller abort listener after completion', async () => {
            const controller = new AbortController();
            const addSpy = jest.spyOn(controller.signal, 'addEventListener');
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');

            const { transport, operation } = createOperationFixture({
                signal: controller.signal,
            });
            transport.request.mockResolvedValue(createResponse());

            await operation.perform();

            expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
        });
    });
});
