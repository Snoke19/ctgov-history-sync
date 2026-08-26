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
import type { EndpointManager } from '../../../src/http/endpoint/manager/endpointManager.js';
import { HttpResponse, HttpTransport } from '../../../src/http/transport/httpTransport.js';
import { FetchOperation } from '../../../src/retry/fetchOperation.js';
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

function createEndpoint(transport: HttpTransport): EndpointHandle {
    return {
        url: 'https://proxy.example.com',
        transport,
    };
}

function createEndpointManager(endpoint: EndpointHandle): jest.Mocked<Pick<EndpointManager, 'acquireEndpoint'>> {
    return {
        acquireEndpoint: jest.fn<(signal: AbortSignal) => Promise<EndpointHandle>>().mockResolvedValue(endpoint),
    };
}

function createOperation(
    endpointManager: Pick<EndpointManager, 'acquireEndpoint'>,
    transportOptions: {
        headers?: Record<string, string>;
        signal?: AbortSignal;
        timeoutMs?: number;
    } = {},
    url = URL,
) {
    return new FetchOperation(
        endpointManager as EndpointManager,
        url,
        {
            ...transportOptions,
        },
        {
            timeoutMs: DEFAULT_TIMEOUT_MS,
            userAgent: USER_AGENT,
        },
    );
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
        const transport = createMockTransport();
        const transportAbortError = new Error('The operation was aborted.');
        transport.request.mockImplementation((options) => {
            return new Promise<HttpResponse>((_, reject) => {
                rejectOnAbort(options.signal, reject, transportAbortError);
            });
        });
        const endpoint = createEndpoint(transport);
        const endpointManager = createEndpointManager(endpoint);
        const operation = createOperation(endpointManager, {
            timeoutMs,
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
            const transport = createMockTransport();
            const response = createResponse();

            transport.request.mockResolvedValue(response);

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).resolves.toBe(response);

            expect(endpointManager.acquireEndpoint).toHaveBeenCalledTimes(1);
            expect(endpointManager.acquireEndpoint).toHaveBeenCalledWith(expect.any(AbortSignal));
            expect(transport.request).toHaveBeenCalledTimes(1);
        });

        it('uses GET and passes the operation abort signal to transport', async () => {
            const transport = createMockTransport();
            transport.request.mockResolvedValue(createResponse());

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

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
            const transport = createMockTransport();
            transport.request.mockResolvedValue(createResponse());

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

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
            const transport = createMockTransport();
            transport.request.mockResolvedValue(createResponse());

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);

            const operation = createOperation(endpointManager, {
                headers: {
                    Accept: 'application/xml',
                    'X-Test': 'true',
                },
            });

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
            const transport = createMockTransport();
            transport.request.mockResolvedValue(createResponse());

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);

            const operation = createOperation(endpointManager, {
                headers: {
                    [headerName]: 'application/xml',
                },
            });

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
                const transport = createMockTransport();
                transport.request.mockResolvedValue(createResponse());

                const endpoint = createEndpoint(transport);
                const endpointManager = createEndpointManager(endpoint);

                const operation = createOperation(endpointManager, {
                    headers: {
                        [headerName]: 'OverrideAgent/2.0',
                    },
                });

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
    });

    describe('endpoint acquisition', () => {
        it('converts EndpointAcquisitionTimeoutError into TimeoutException', async () => {
            const endpointManager = {
                acquireEndpoint: jest
                    .fn<(signal: AbortSignal) => Promise<EndpointHandle>>()
                    .mockRejectedValue(new EndpointAcquisitionTimeoutError(2_500, 5)),
            } as unknown as EndpointManager;

            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'TimeoutException',
                message: expect.stringContaining('Endpoint acquisition timed out after 2500ms'),
                cause: expect.any(EndpointAcquisitionTimeoutError),
            });
        });

        it('does not start the request timeout before endpoint acquisition completes', async () => {
            const transport = createMockTransport();
            transport.request.mockResolvedValue(createResponse());
            let resolveAcquisition!: (endpoint: EndpointHandle) => void;
            const acquisition = new Promise<EndpointHandle>((resolve) => {
                resolveAcquisition = resolve;
            });
            const endpointManager = {
                acquireEndpoint: jest
                    .fn<(signal: AbortSignal) => Promise<EndpointHandle>>()
                    .mockReturnValue(acquisition),
            } as unknown as EndpointManager;

            const operation = createOperation(endpointManager, {
                timeoutMs: 1_000,
            });
            const promise = operation.perform();
            await jest.advanceTimersByTimeAsync(1_000);

            expect(transport.request).not.toHaveBeenCalled();
            resolveAcquisition(createEndpoint(transport));
            await promise;
            expect(transport.request).toHaveBeenCalledTimes(1);
        });

        it('prioritizes caller cancellation over endpoint acquisition timeout', async () => {
            const controller = new AbortController();

            const endpointManager = {
                acquireEndpoint: jest.fn().mockImplementation(async () => {
                    controller.abort();

                    throw new EndpointAcquisitionTimeoutError(1_000, 1);
                }),
            } as unknown as EndpointManager;

            const operation = createOperation(endpointManager, {
                signal: controller.signal,
                timeoutMs: 1_000,
            });

            await expect(operation.perform()).rejects.toBeInstanceOf(CallerAbortedError);
        });
    });

    describe('caller cancellation', () => {
        it('throws CallerAbortedError when the caller signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();
            const transport = createMockTransport();
            const endpoint = createEndpoint(transport);
            const endpointManager = {
                acquireEndpoint: jest
                    .fn<(signal: AbortSignal) => Promise<EndpointHandle>>()
                    .mockImplementation(async (signal) => {
                        if (signal.aborted) {
                            throw new CallerAbortedError();
                        }
                        return endpoint;
                    }),
            } as unknown as EndpointManager;
            const operation = createOperation(endpointManager, {
                signal: controller.signal,
            });

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(endpointManager.acquireEndpoint).toHaveBeenCalledWith(expect.any(AbortSignal));
            expect(transport.request).not.toHaveBeenCalled();
        });

        it('converts an existing CallerAbortedError into the operation-level caller error', async () => {
            const originalError = new CallerAbortedError('endpoint acquisition was cancelled');

            const endpointManager = {
                acquireEndpoint: jest
                    .fn<(signal: AbortSignal) => Promise<EndpointHandle>>()
                    .mockRejectedValue(originalError),
            } as unknown as EndpointManager;

            const operation = createOperation(endpointManager);

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error).not.toBe(originalError);

            expect((error as CallerAbortedError).message).toContain('Request cancelled by caller');
            expect((error as CallerAbortedError).cause).toBe(originalError);
        });

        it('throws CallerAbortedError when the caller aborts during the request', async () => {
            const transportAbortError = new Error('The operation was aborted.');
            const controller = new AbortController();

            const transport = createMockTransport();

            transport.request.mockImplementation((_options) => {
                return new Promise<HttpResponse>((_, reject) => {
                    rejectOnAbort(_options.signal, reject);
                });
            });

            transport.classifyError.mockReturnValue({
                kind: 'cancelled',
                cause: transportAbortError,
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);

            const operation = createOperation(endpointManager, {
                signal: controller.signal,
            });

            const promise = operation.perform();

            controller.abort();

            await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);
        });

        it('prioritizes caller cancellation over the internal timeout', async () => {
            const controller = new AbortController();
            const transportAbortError = new Error('The operation was aborted.');
            const transport = createMockTransport();
            transport.request.mockImplementation((options) => {
                return new Promise<HttpResponse>((_, reject) => {
                    rejectOnAbort(options.signal, reject, transportAbortError);
                });
            });
            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager, {
                signal: controller.signal,
                timeoutMs: DEFAULT_TIMEOUT_MS,
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
            const transport = createMockTransport();
            const original = new TrialError('already classified');

            transport.request.mockRejectedValue(original);

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toBe(original);

            expect(transport.classifyError).not.toHaveBeenCalled();
        });

        it('converts a transport timeout into TimeoutException', async () => {
            const transport = createMockTransport();
            const cause = new Error('headers timeout');

            transport.request.mockRejectedValue(new Error('transport failure'));
            transport.classifyError.mockReturnValue({
                kind: 'timeout',
                cause,
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'TimeoutException',
                cause,
                message: expect.stringContaining('headers timeout'),
            });
        });

        it('converts a network failure into NetworkException', async () => {
            const transport = createMockTransport();
            const cause = Object.assign(new Error('connection reset'), {
                code: 'ECONNRESET',
            });

            transport.request.mockRejectedValue(new Error('transport failure'));
            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause,
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'NetworkException',
                cause,
                message: expect.stringContaining('ECONNRESET'),
            });
        });

        it('converts an unknown transport failure into UnexpectedError', async () => {
            const transport = createMockTransport();
            const cause = new Error('unexpected transport state');

            transport.request.mockRejectedValue(cause);
            transport.classifyError.mockReturnValue({
                kind: 'unknown',
                cause,
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'UnexpectedError',
                cause,
            });
        });

        it('does not turn unknown transport cancellation into CallerAbortedError', async () => {
            const transport = createMockTransport();
            const cause = new Error('transport cancelled itself');

            transport.request.mockRejectedValue(cause);
            transport.classifyError.mockReturnValue({
                kind: 'cancelled',
                cause,
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toBeInstanceOf(UnexpectedError);
        });

        it('preserves a transport timeout when no AbortController reason is present', async () => {
            const transport = createMockTransport();
            const cause = new Error('socket timeout');

            transport.request.mockRejectedValue(cause);
            transport.classifyError.mockReturnValue({
                kind: 'timeout',
                cause,
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toBeInstanceOf(TimeoutException);
        });
    });

    describe('HTTP responses', () => {
        it('preserves HttpException when response body draining fails', async () => {
            const transport = createMockTransport();
            const discardError = new Error('discard failed');
            const discard = jest.fn<() => Promise<void>>().mockRejectedValue(discardError);
            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    discard,
                }),
            );

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            const error = await operation.perform().catch((value: unknown) => value);
            expect(discard).toHaveBeenCalledTimes(1);
            expect(error).toBeInstanceOf(HttpException);
            expect((error as HttpException).status).toBe(503);
        });

        it('extracts Retry-After HTTP-date into HttpException', async () => {
            const transport = createMockTransport();
            const now = Date.parse('2026-08-26T12:00:00.000Z');
            const retryAt = new Date(now + 30_000).toUTCString();
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
            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = new FetchOperation(
                endpointManager as unknown as EndpointManager,
                URL,
                {},
                {
                    timeoutMs: DEFAULT_TIMEOUT_MS,
                    userAgent: USER_AGENT,
                },
                () => now,
            );

            const error = await operation.perform().catch((value: unknown) => value);
            expect(error).toBeInstanceOf(HttpException);
            const httpError = error as HttpException;
            expect(httpError.status).toBe(429);
            expect(httpError.retryAfterMs).toBe(30_000);
        });

        it.each([
            [400, 'Bad Request'],
            [404, 'Not Found'],
            [500, 'Internal Server Error'],
            [503, 'Service Unavailable'],
        ])('throws HttpException for HTTP %s responses', async (status, statusText) => {
            const transport = createMockTransport();

            const discard = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

            const response = createResponse({
                ok: false,
                status,
                statusText,
                discard,
            });

            transport.request.mockResolvedValue(response);

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toMatchObject({
                name: 'HttpException',
                status,
                message: expect.stringContaining(`HTTP ${status} ${statusText}`),
            });

            expect(discard).toHaveBeenCalledTimes(1);
        });

        it('extracts Retry-After delay-seconds into HttpException', async () => {
            const transport = createMockTransport();

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

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(HttpException);
            expect(error).toMatchObject({
                status: 503,
                retryAfterMs: 12_000,
            });
        });

        it('sets Retry-After to undefined when the header is malformed', async () => {
            const transport = createMockTransport();

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

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

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
            const transport = createMockTransport();

            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                }),
            );

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);

            const operation = createOperation(
                endpointManager,
                {},
                'https://username:super-secret@example.com/trials?token=secret',
            );

            await expect(operation.perform()).rejects.toMatchObject({
                message: expect.stringContaining('https://example.com/trials'),
            });
        });

        it('uses a safe placeholder for an invalid URL', async () => {
            const transport = createMockTransport();

            transport.request.mockResolvedValue(
                createResponse({
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                }),
            );

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);

            const operation = createOperation(endpointManager, {}, 'not a valid url');

            await expect(operation.perform()).rejects.toMatchObject({
                message: expect.stringContaining('<invalid URL>'),
            });
        });
    });

    describe('error messages', () => {
        it('includes a string transport cause without throwing while formatting the error', async () => {
            const transport = createMockTransport();

            transport.request.mockRejectedValue('connection failed');

            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause: 'connection failed',
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(NetworkException);

            expect((error as NetworkException).message).toContain('connection failed');
        });

        it('does not expose sensitive fields from an arbitrary transport cause', async () => {
            const transport = createMockTransport();

            const sensitiveCause = {
                message: 'connection failed',
                username: 'admin',
                password: 'super-secret-password',
                token: 'super-secret-token',
            };

            transport.request.mockRejectedValue(sensitiveCause);

            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause: sensitiveCause,
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            const error = await operation.perform().catch((value: unknown) => value);

            expect(error).toBeInstanceOf(NetworkException);

            const message = (error as NetworkException).message;

            expect(message).toContain('https://example.com/trials');

            expect(message).not.toContain('super-secret-password');
            expect(message).not.toContain('super-secret-token');
        });
    });

    describe('request timeout', () => {
        it('throws TimeoutException when the internal request timeout aborts the transport', async () => {
            const transport = createMockTransport();
            const transportAbortError = new Error('The operation was aborted.');
            transport.request.mockImplementation((options) => {
                return new Promise<HttpResponse>((_, reject) => {
                    rejectOnAbort(options.signal, reject, transportAbortError);
                });
            });
            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager, {
                timeoutMs: DEFAULT_TIMEOUT_MS,
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
    });

    describe('abort and timeout cleanup', () => {
        it('clears the request timeout after a successful request', async () => {
            const transport = createMockTransport();
            transport.request.mockResolvedValue(createResponse());

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await operation.perform();

            expect(jest.getTimerCount()).toBe(0);
        });

        it('clears the request timeout after a failed request', async () => {
            const transport = createMockTransport();

            transport.request.mockRejectedValue(new Error('network down'));
            transport.classifyError.mockReturnValue({
                kind: 'network',
                cause: new Error('ECONNRESET'),
            });

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager);

            await expect(operation.perform()).rejects.toBeInstanceOf(NetworkException);

            expect(jest.getTimerCount()).toBe(0);
        });

        it('removes the caller abort listener after completion', async () => {
            const controller = new AbortController();
            const addSpy = jest.spyOn(controller.signal, 'addEventListener');
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');

            const transport = createMockTransport();
            transport.request.mockResolvedValue(createResponse());

            const endpoint = createEndpoint(transport);
            const endpointManager = createEndpointManager(endpoint);
            const operation = createOperation(endpointManager, {
                signal: controller.signal,
            });

            await operation.perform();

            expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });

            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
        });
    });
});
