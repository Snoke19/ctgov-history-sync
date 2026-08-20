import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import type { DestinationStream } from 'pino';
import type { Dispatcher, ProxyAgent } from 'undici';
import { withLogContext, getLogContext } from '../../../src/config/logContext.js';
import { createLogger, setLoggerDestinationForTests } from '../../../src/config/logging.js';
import { ApiResponseValidationError, NetworkException, UnexpectedError } from '../../../src/error/errors.js';
import type { EndpointProvider } from '../../../src/http/endpoint/provider/endpointProvider.js';
import type {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
} from '../../../src/http/transport/impl/undiciProxyTransport.js';

interface LogRecord {
    level: number;
    msg?: string;
    requestId?: string;
    correlationId?: string;
    [key: string]: unknown;
}

const records: LogRecord[] = [];

const sink: DestinationStream = {
    write: (chunk: string) => {
        records.push(JSON.parse(chunk) as LogRecord);
    },
};

// Module-scope loggers are created when the HTTP modules are imported below.
// LOG_LEVEL must be debug and the destination must be the in-memory sink
// before those imports run, so every log record is captured and debug records
// are emitted.
const originalLogLevel = process.env.LOG_LEVEL;

process.env.LOG_LEVEL = 'debug';
setLoggerDestinationForTests(sink);

const { createHttpClient } = await import('../../../src/http/httpClient.js');
const { DefaultEndpointManagerFactory } =
    await import('../../../src/http/endpoint/manager/defaultEndpointManagerFactory.js');
const { DirectEndpointProvider } = await import('../../../src/http/endpoint/provider/impl/directEndpointProvider.js');
const { ProxyEndpointProvider } = await import('../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js');
const { HttpProxyUrlParser } = await import('../../../src/http/endpoint/proxy/httpProxyUrlParser.js');
const { EndpointFactory } = await import('../../../src/http/endpoint/endpointFactory.js');
const { DefaultLimiterFactory } = await import('../../../src/http/limiter/factory/defaultLimiterFactory.js');
const { FetchDirectTransportFactory } = await import('../../../src/http/transport/impl/fetchDirectTransport.js');
const { UndiciTransportFactory } = await import('../../../src/http/transport/impl/undiciProxyTransport.js');
const { API_URL, jsonResponse } = await import('./httpClient/helpers.js');

function makeClient() {
    return createHttpClient({
        provider: new DirectEndpointProvider(new FetchDirectTransportFactory()),
        limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
        endpointManagerFactory: new DefaultEndpointManagerFactory({
            acquireTimeout: 5000,
        }),
    });
}

const FAKE_POOL_CONFIG = {
    connections: 1,
    maxConnections: 10,
    pipelining: 1,
    keepAliveTimeout: 300_000,
    headersTimeout: 15_000,
    bodyTimeout: 45_000,
    connectTimeout: 5_000,
};

describe('logging strategy', () => {
    afterAll(() => {
        setLoggerDestinationForTests(undefined);

        if (originalLogLevel === undefined) {
            delete process.env.LOG_LEVEL;
        } else {
            process.env.LOG_LEVEL = originalLogLevel;
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('logs when an unknown transport error is classified as non-retryable', async () => {
        const failure = new TypeError('unexpected transport failure');

        const failingTransport = {
            request: async () => {
                throw failure;
            },
            classifyError: () => ({
                kind: 'unknown' as const,
                cause: failure,
            }),
            close: async () => {},
        };

        const provider: EndpointProvider = {
            build: () => [
                {
                    id: 'direct',
                    createTransport: () => failingTransport,
                },
            ],
        };

        const client = await createHttpClient({
            provider,
            limiterFactory: new DefaultLimiterFactory({
                enabled: false,
                capacity: 1,
                windowMs: 1000,
            }),
            endpointManagerFactory: new DefaultEndpointManagerFactory({
                acquireTimeout: 5000,
            }),
        });

        try {
            await withLogContext({ correlationId: 'corr-unknown-error' }, async () => {
                await expect(client.fetchJson(`${API_URL}/unexpected`, { maxRetries: 3 })).rejects.toBeInstanceOf(
                    UnexpectedError,
                );
            });
        } finally {
            await client.close();
        }

        const record = records.find((record) => record.msg === 'Unknown transport error; retry disabled');

        expect(record).toBeDefined();
        expect(record).toMatchObject({
            correlationId: 'corr-unknown-error',
            errorType: 'UnexpectedError',
        });
    });

    it('propagates correlationId across all layers and assigns one requestId per request', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));

        const client = await makeClient();

        try {
            await withLogContext({ correlationId: 'corr-log-test-1' }, async () => {
                await client.fetchJson(`${API_URL}/a`);
                await client.fetchJson(`${API_URL}/b`);
            });
        } finally {
            await client.close();
        }

        expect(fetchMock).toHaveBeenCalledTimes(2);

        const contextRecords = records.filter((record) => record.correlationId === 'corr-log-test-1');

        expect(contextRecords.length).toBeGreaterThan(0);

        for (const record of contextRecords) {
            expect(record.correlationId).toBe('corr-log-test-1');
        }

        const requestLogs = contextRecords.filter((record) => typeof record.requestId === 'string');

        expect(requestLogs.length).toBeGreaterThan(0);

        const requestIds = new Set(requestLogs.map((record) => record.requestId as string));

        expect(requestIds.size).toBe(2);

        for (const requestId of requestIds) {
            const group = requestLogs.filter((record) => record.requestId === requestId);
            const messages = group.map((record) => record.msg);

            expect(messages).toContain('HTTP request started');
            expect(messages).toContain('HTTP request completed');
        }
    });

    it('logs HTTP request lifecycle with structured request fields', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));

        const client = await makeClient();

        try {
            await withLogContext({ correlationId: 'corr-lifecycle' }, async () => {
                await client.fetchJson(`${API_URL}/trials?pageSize=10`);
            });
        } finally {
            await client.close();
        }

        const lifecycleRecords = records.filter((record) => record.correlationId === 'corr-lifecycle');

        const started = lifecycleRecords.find((record) => record.msg === 'HTTP request started');

        expect(started).toBeDefined();
        expect(started).toMatchObject({
            correlationId: 'corr-lifecycle',
            operation: 'http.fetchJson',
            method: 'GET',
            url: `${API_URL}/trials`,
            allow404: false,
        });
        expect(typeof started?.requestId).toBe('string');

        const completed = lifecycleRecords.find((record) => record.msg === 'HTTP request completed');

        expect(completed).toBeDefined();
        expect(completed).toMatchObject({
            correlationId: 'corr-lifecycle',
            operation: 'http.fetchJson',
            method: 'GET',
            status: 200,
        });
        expect(typeof completed?.durationMs).toBe('number');
    });

    it('keeps correlationId and requestId distinct across concurrent requests', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));

        const client = await makeClient();

        try {
            await Promise.all([
                withLogContext({ correlationId: 'corr-A' }, () => client.fetchJson(`${API_URL}/a`)),
                withLogContext({ correlationId: 'corr-B' }, () => client.fetchJson(`${API_URL}/b`)),
            ]);
        } finally {
            await client.close();
        }

        expect(fetchMock).toHaveBeenCalledTimes(2);

        const requestLogs = records.filter(
            (record) =>
                (record.correlationId === 'corr-A' || record.correlationId === 'corr-B') &&
                typeof record.requestId === 'string',
        );

        const correlationIds = new Set(requestLogs.map((record) => record.correlationId as string));

        expect(correlationIds).toEqual(new Set(['corr-A', 'corr-B']));

        const requestIds = new Set(requestLogs.map((record) => record.requestId as string));

        expect(requestIds.size).toBe(2);
    });

    it('never logs proxy credentials in endpoint identifiers', async () => {
        const proxyUrl = 'http://user:password@example.com:8080';

        const fakePoolClientFactory = jest.fn<PoolClientFactory>().mockReturnValue({} as unknown as Dispatcher);
        const fakePoolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(fakePoolClientFactory);
        const fakeAgent = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as ProxyAgent;
        const fakeAgentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(fakeAgent);

        const transportFactory = new UndiciTransportFactory({
            poolConfig: FAKE_POOL_CONFIG,
            poolCreator: fakePoolCreator,
            agentCreator: fakeAgentCreator,
        });

        const provider = new ProxyEndpointProvider(transportFactory, new HttpProxyUrlParser(), {
            proxyUrls: proxyUrl,
            concurrency: 1,
        });

        const factory = new EndpointFactory(
            provider,
            new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
        );

        const endpoints = await factory.build();

        await Promise.all(endpoints.map((endpoint) => endpoint.close()));

        const serialized = JSON.stringify(records);

        expect(serialized).not.toContain('user:password');
        expect(serialized).not.toContain('password@example.com');
        expect(serialized).toContain('http://example.com:8080');
    });

    it('never logs proxy credentials during request execution', async () => {
        const fakePoolClientFactory = jest.fn<PoolClientFactory>().mockReturnValue({} as unknown as Dispatcher);
        const fakePoolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(fakePoolClientFactory);
        const fakeAgent = {
            dispatch: jest.fn(
                (
                    _options: unknown,
                    handler: {
                        onRequestStart?: (controller: unknown) => void;
                        onResponseStarted?: () => void;
                        onResponseStart: (
                            controller: unknown,
                            status: number,
                            headers: Record<string, string>,
                            statusText: string,
                        ) => void;
                        onResponseData?: (controller: unknown, chunk: Buffer) => void;
                        onResponseEnd?: () => void;
                    },
                ) => {
                    const controller = {
                        resume: () => {},
                        pause: () => {},
                        abort: () => {},
                        rawHeaders: ['content-type', 'application/json'],
                    };

                    handler.onRequestStart?.(controller);
                    handler.onResponseStarted?.();
                    handler.onResponseStart(controller, 200, {}, 'OK');
                    handler.onResponseData?.(controller, Buffer.from('{}'));
                    handler.onResponseEnd?.();

                    return true;
                },
            ),
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as ProxyAgent;
        const fakeAgentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(fakeAgent);

        const transportFactory = new UndiciTransportFactory({
            poolConfig: FAKE_POOL_CONFIG,
            poolCreator: fakePoolCreator,
            agentCreator: fakeAgentCreator,
        });

        const provider = new ProxyEndpointProvider(transportFactory, new HttpProxyUrlParser(), {
            proxyUrls: 'http://user:password@example.com:8080',
            concurrency: 1,
        });

        const client = await createHttpClient({
            provider,
            limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
            endpointManagerFactory: new DefaultEndpointManagerFactory({ acquireTimeout: 5000 }),
        });

        try {
            await withLogContext({ correlationId: 'corr-request-creds' }, async () => {
                await client.fetchJson(`${API_URL}/studies`);
            });
        } finally {
            await client.close();
        }

        expect(fakeAgent.dispatch).toHaveBeenCalledTimes(1);

        const serialized = JSON.stringify(records);

        expect(serialized).not.toContain('user:password');
        expect(serialized).not.toContain('password@example.com');
    });

    it('keeps the correlationId stable across retries', async () => {
        const failure = new Error('socket hang up');

        const failingTransport = {
            request: async () => {
                throw failure;
            },
            classifyError: () => ({
                kind: 'network' as const,
                cause: failure,
            }),
            close: async () => {},
        };

        const provider: EndpointProvider = {
            build: () => [
                {
                    id: 'direct',
                    createTransport: () => failingTransport,
                },
            ],
        };

        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const client = await createHttpClient({
            provider,
            limiterFactory: new DefaultLimiterFactory({
                enabled: false,
                capacity: 1,
                windowMs: 1000,
            }),
            endpointManagerFactory: new DefaultEndpointManagerFactory({
                acquireTimeout: 5000,
            }),
            retryConfig: {
                retryOnTimeout: false,
                retryOnNetworkError: true,
                retryableStatusCodes: new Set([500]),
            },
            sleep,
        });

        try {
            await withLogContext({ correlationId: 'corr-retries' }, async () => {
                await expect(
                    client.fetchJson(`${API_URL}/down`, {
                        maxRetries: 1,
                    }),
                ).rejects.toMatchObject({
                    name: 'NetworkException',
                });
            });
        } finally {
            await client.close();
        }

        const retryRecords = records.filter((record) => record.correlationId === 'corr-retries');

        expect(retryRecords.length).toBeGreaterThan(0);

        for (const record of retryRecords) {
            expect(record.correlationId).toBe('corr-retries');
        }

        const requestIds = new Set(
            retryRecords.map((record) => record.requestId).filter((id): id is string => typeof id === 'string'),
        );

        expect(requestIds.size).toBe(1);

        const requestId = [...requestIds][0];

        expect(requestId).toBeDefined();

        const retrying = retryRecords.find((record) => record.msg === 'Operation failed; retrying');

        expect(retrying).toBeDefined();
        expect(retrying?.requestId).toBe(requestId);

        const exhausted = retryRecords.find((record) => record.msg === 'Operation failed; maximum attempts reached');

        expect(exhausted).toBeDefined();
        expect(exhausted?.requestId).toBe(requestId);

        expect(exhausted).toMatchObject({
            attempts: 2,
            maxAttempts: 2,
            errorType: 'NetworkException',
        });

        const err = exhausted?.err as { message?: string; stack?: string } | undefined;

        expect(err?.message).toContain('socket hang up');
        expect(err?.stack).toContain('Error: socket hang up');

        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('preserves the original exception in response parse error logs', async () => {
        jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('not valid json', {
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
            }),
        );

        const client = await makeClient();

        try {
            await withLogContext({ correlationId: 'corr-parse' }, async () => {
                await expect(client.fetchJson(`${API_URL}/bad-json`)).rejects.toBeInstanceOf(
                    ApiResponseValidationError,
                );
            });
        } finally {
            await client.close();
        }

        const parseFailed = records.find((record) => record.msg === 'Failed to parse HTTP response body');

        expect(parseFailed).toBeDefined();
        expect(parseFailed?.correlationId).toBe('corr-parse');

        const err = parseFailed?.err as { message?: string } | undefined;

        expect(err?.message).toContain('Unexpected token');
    });

    it('restores the previous context after the HTTP request completes', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));

        const client = await makeClient();

        await withLogContext({ correlationId: 'corr-restore', operation: 'scrape' }, async () => {
            try {
                await client.fetchJson(`${API_URL}/trials`);

                // After the request completes, the parent context is restored:
                // requestId is gone and operation is no longer 'http.fetchJson'.
                expect(getLogContext()).toEqual({ correlationId: 'corr-restore', operation: 'scrape' });
            } finally {
                await client.close();
            }
        });

        const contextRecords = records.filter((record) => record.correlationId === 'corr-restore');

        const completed = contextRecords.find((record) => record.msg === 'HTTP request completed');

        expect(completed).toBeDefined();
        expect(completed?.operation).toBe('http.fetchJson');
        expect(typeof completed?.requestId).toBe('string');

        // Shutdown logs run after the request and must inherit the outer
        // context rather than the request context.
        const closed = contextRecords.find((record) => record.msg === 'HTTP client closed');

        expect(closed).toBeDefined();
        expect(closed?.requestId).toBeUndefined();
        expect(closed?.operation).toBe('scrape');
    });

    it('does not leak statement-local fields into the shared logging context', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));

        const testLogger = createLogger(import.meta.url);

        const client = await makeClient();

        await withLogContext({ correlationId: 'corr-clean', operation: 'scrape' }, async () => {
            try {
                testLogger.info({ marker: 'parent-scope' }, 'Parent scope log');

                await client.fetchJson(`${API_URL}/trials?pageSize=10`, { allow404: true, maxRetries: 1 });

                // The shared context must only ever contain diagnostic fields.
                expect(getLogContext()).toEqual({ correlationId: 'corr-clean', operation: 'scrape' });
            } finally {
                await client.close();
            }
        });

        const contextRecords = records.filter((record) => record.correlationId === 'corr-clean');

        const parentLog = contextRecords.find((record) => record.msg === 'Parent scope log');

        expect(parentLog).toMatchObject({ marker: 'parent-scope', operation: 'scrape' });

        const started = contextRecords.find((record) => record.msg === 'HTTP request started');

        expect(started).toMatchObject({
            url: `${API_URL}/trials`,
            method: 'GET',
            allow404: true,
            maxRetries: 1,
        });

        const completed = contextRecords.find((record) => record.msg === 'HTTP request completed');

        expect(completed).toBeDefined();

        // Statement fields from earlier records must not reappear on later ones.
        expect(completed?.marker).toBeUndefined();
        expect(completed?.allow404).toBeUndefined();
        expect(completed?.maxRetries).toBeUndefined();

        const closed = contextRecords.find((record) => record.msg === 'HTTP client closed');

        expect(closed).toBeDefined();
        expect(closed?.marker).toBeUndefined();
        expect(closed?.url).toBeUndefined();
        expect(closed?.allow404).toBeUndefined();
        expect(closed?.maxRetries).toBeUndefined();
        expect(closed?.requestId).toBeUndefined();
        expect(closed?.operation).toBe('scrape');
    });

    it('emits exactly one correlationId across a complete client run', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));

        const before = records.length;

        // Mirrors src/index.ts: the whole run (client construction, requests,
        // shutdown) executes inside one application-boundary context, and the
        // HTTP layer must never generate a second correlationId.
        await withLogContext({ correlationId: 'corr-single-run' }, async () => {
            const client = await makeClient();

            try {
                await client.fetchJson(`${API_URL}/a`);
                await client.fetchJson(`${API_URL}/b`);
            } finally {
                await client.close();
            }
        });

        const newRecords = records.slice(before);

        expect(newRecords.length).toBeGreaterThan(0);

        const correlationIds = new Set(
            newRecords.map((record) => record.correlationId).filter((id): id is string => typeof id === 'string'),
        );

        expect(correlationIds).toEqual(new Set(['corr-single-run']));

        for (const msg of [
            'HTTP client created',
            'HTTP request started',
            'HTTP request completed',
            'HTTP client closed',
        ]) {
            expect(newRecords.some((record) => record.msg === msg)).toBe(true);
        }
    });

    it('creates an explicit standalone request context when no application context is active', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));

        const client = await makeClient();

        try {
            const before = records.length;

            await client.fetchJson(`${API_URL}/standalone-1`);
            const afterFirst = records.length;

            await client.fetchJson(`${API_URL}/standalone-2`);

            const firstRecords = records.slice(before, afterFirst);
            const secondRecords = records.slice(afterFirst);

            // The fallback is explicit: a debug record announces the standalone
            // context creation inside the new request context, so it carries
            // the generated correlationId and requestId.
            const firstFallbackRecord = firstRecords.find(
                (record) => record.msg === 'No active logging context; generated standalone request context',
            );

            expect(firstFallbackRecord).toBeDefined();
            expect(typeof firstFallbackRecord?.correlationId).toBe('string');
            expect(typeof firstFallbackRecord?.requestId).toBe('string');
            expect(firstFallbackRecord?.operation).toBe('http.fetchJson');

            const secondFallbackRecord = secondRecords.find(
                (record) => record.msg === 'No active logging context; generated standalone request context',
            );

            expect(secondFallbackRecord).toBeDefined();
            expect(typeof secondFallbackRecord?.correlationId).toBe('string');
            expect(typeof secondFallbackRecord?.requestId).toBe('string');

            const firstCorrelationId = firstRecords.find(
                (record) => typeof record.correlationId === 'string',
            )?.correlationId;
            const secondCorrelationId = secondRecords.find(
                (record) => typeof record.correlationId === 'string',
            )?.correlationId;

            expect(typeof firstCorrelationId).toBe('string');
            expect(typeof secondCorrelationId).toBe('string');
            expect(firstCorrelationId).not.toBe(secondCorrelationId);

            const firstRequestId = firstRecords.find((record) => typeof record.requestId === 'string')?.requestId;

            expect(typeof firstRequestId).toBe('string');
        } finally {
            await client.close();
        }
    });

    it('does not emit ERROR logs when retries are exhausted and the caller handles the failure', async () => {
        const failure = new Error('socket hang up');

        const failingTransport = {
            request: async () => {
                throw failure;
            },
            classifyError: () => ({
                kind: 'network' as const,
                cause: failure,
            }),
            close: async () => {},
        };

        const provider: EndpointProvider = {
            build: () => [
                {
                    id: 'direct',
                    createTransport: () => failingTransport,
                },
            ],
        };

        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const client = await createHttpClient({
            provider,
            limiterFactory: new DefaultLimiterFactory({
                enabled: false,
                capacity: 1,
                windowMs: 1000,
            }),
            endpointManagerFactory: new DefaultEndpointManagerFactory({
                acquireTimeout: 5000,
            }),
            retryConfig: {
                retryOnTimeout: false,
                retryOnNetworkError: true,
                retryableStatusCodes: new Set([500]),
            },
            sleep,
        });

        try {
            await withLogContext({ correlationId: 'corr-no-error' }, async () => {
                await expect(client.fetchJson(`${API_URL}/down`, { maxRetries: 1 })).rejects.toBeInstanceOf(
                    NetworkException,
                );
            });
        } finally {
            await client.close();
        }

        const runRecords = records.filter((record) => record.correlationId === 'corr-no-error');

        expect(runRecords.length).toBeGreaterThan(0);

        // Retry exhaustion is WARN, not ERROR.
        expect(runRecords.some((record) => record.level >= 50)).toBe(false);

        const exhausted = runRecords.find((record) => record.msg === 'Operation failed; maximum attempts reached');

        expect(exhausted).toBeDefined();
        expect(exhausted).toMatchObject({
            attempts: 2,
            maxAttempts: 2,
            errorType: 'NetworkException',
        });

        expect(exhausted?.level).toBe(40);
    });

    it('sanitizes credentials out of exception messages and error logs', async () => {
        const failure = new Error('connection refused');

        const failingTransport = {
            request: async () => {
                throw failure;
            },
            classifyError: () => ({ kind: 'network' as const, cause: failure }),
            close: async () => {},
        };

        const provider: EndpointProvider = {
            build: () => [{ id: 'direct', createTransport: () => failingTransport }],
        };

        const client = await createHttpClient({
            provider,
            limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
            endpointManagerFactory: new DefaultEndpointManagerFactory({ acquireTimeout: 5000 }),
        });

        let thrownMessage: string | undefined;

        try {
            await withLogContext({ correlationId: 'corr-creds-err' }, async () => {
                try {
                    await client.fetchJson('http://user:secret@api.test/studies', { maxRetries: 0 });
                } catch (err: unknown) {
                    thrownMessage = err instanceof Error ? err.message : String(err);
                }
            });
        } finally {
            await client.close();
        }

        const runRecords = records.filter((record) => record.correlationId === 'corr-creds-err');

        const serialized = JSON.stringify(runRecords);

        expect(serialized).not.toContain('user:secret');
        expect(serialized).not.toContain('secret@api.test');
        expect(serialized).toContain('http://api.test');

        expect(thrownMessage).toBeDefined();
        expect(thrownMessage).not.toContain('user:secret');
        expect(thrownMessage).toContain('http://api.test/studies');
    });
});
