import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProxyPoolConfig } from '../../../../../src/config/config.js';
import { ConfigurationError } from '../../../../../src/error/errors.js';
import { Endpoint } from '../../../../../src/http/endpoint/endpoint.js';
import { ProxyUrlParser } from '../../../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { ProxyTransportFactory } from '../../../../../src/http/endpoint/transport/factory/proxyTransportFactory.js';
import {
    CreateProxyEndpointsOptions,
    HttpTransport,
} from '../../../../../src/http/endpoint/transport/httpTransport.js';
import { Limiter } from '../../../../../src/http/limiter/limiter.js';
import { HttpClientOptions } from '../../../../../src/http/types/http.js';
import * as validation from '../../../../../src/utils/validation.js';

const assertPositiveInt = jest.fn();

jest.unstable_mockModule('../../../../../src/utils/validation.js', () => ({
    ...validation,
    assertPositiveInt,
}));

const { ProxyEndpointProvider } =
    await import('../../../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js');

describe('ProxyEndpointProvider', () => {
    let transportFactory: jest.Mocked<ProxyTransportFactory>;
    let urlParser: jest.Mocked<ProxyUrlParser>;
    let createLimiter: jest.Mock<() => Limiter>;
    let provider: InstanceType<typeof ProxyEndpointProvider>;

    const makeLimiter = (): Limiter =>
        ({
            tryAcquire: jest.fn().mockReturnValue(true),
            timeUntilToken: jest.fn().mockReturnValue(0),
        }) as unknown as Limiter;

    const makeTransport = (): HttpTransport => ({ close: jest.fn() }) as unknown as HttpTransport;

    type MakeOptionsOverrides = {
        concurrency?: number | undefined;
        poolConfig?: Partial<ProxyPoolConfig> | null | undefined;
        proxyUrls?: string | undefined;
        useRateLimit?: boolean | undefined;
        rateLimitCapacity?: number | undefined;
        rateLimitWindow?: number | undefined;
        acquireTimeout?: number | undefined;
    };

    const makeOptions = (overrides?: MakeOptionsOverrides): HttpClientOptions => {
        const hasPoolConfig = overrides && 'poolConfig' in overrides;
        const poolConfigValue = hasPoolConfig
            ? overrides.poolConfig === null || overrides.poolConfig === undefined
                ? undefined
                : (overrides.poolConfig as unknown as ProxyPoolConfig)
            : ({} as unknown as ProxyPoolConfig);

        const rest = { ...overrides };
        delete rest.poolConfig;

        return {
            concurrency: 1,
            proxyUrls: 'http://proxy:8080',
            ...(hasPoolConfig && poolConfigValue === undefined ? {} : { poolConfig: poolConfigValue }),
            ...rest,
        } as HttpClientOptions;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        assertPositiveInt.mockImplementation(() => {});

        transportFactory = { create: jest.fn() } as unknown as jest.Mocked<ProxyTransportFactory>;
        urlParser = { parse: jest.fn() } as unknown as jest.Mocked<ProxyUrlParser>;
        createLimiter = jest.fn<() => Limiter>(makeLimiter);
        transportFactory.create.mockImplementation(makeTransport);

        provider = new ProxyEndpointProvider(transportFactory, urlParser);
    });

    describe('happy path', () => {
        it('builds one endpoint per parsed proxy URL', () => {
            const urls = ['http://proxy1:8080', 'http://proxy2:8080'];
            urlParser.parse.mockReturnValue(urls);

            const result = provider.build(makeOptions({ proxyUrls: urls.join(',') }), createLimiter);

            expect(result).toHaveLength(2);
            result.forEach((ep) => expect(ep).toBeInstanceOf(Endpoint));
        });

        it('passes the correct CreateProxyEndpointsOptions to the transport factory', () => {
            urlParser.parse.mockReturnValue(['socks5://proxy:1080']);

            provider.build(
                makeOptions({
                    concurrency: 3,
                    poolConfig: { maxConnections: 20 },
                    proxyUrls: 'socks5://proxy:1080',
                }),
                createLimiter,
            );

            expect(transportFactory.create).toHaveBeenCalledWith(
                'socks5://proxy:1080',
                expect.objectContaining({
                    concurrency: 3,
                    proxyCount: 1,
                    poolConfig: { maxConnections: 20 },
                }),
            );
        });

        it('assigns each proxy URL to its corresponding endpoint instance', () => {
            const urls = ['http://a:1', 'http://b:2'];
            urlParser.parse.mockReturnValue(urls);

            const result = provider.build(makeOptions(), createLimiter);

            expect(result.map((e) => e.url)).toEqual(urls);
        });

        it('creates a fresh limiter for every endpoint', () => {
            urlParser.parse.mockReturnValue(['p1', 'p2', 'p3']);

            provider.build(makeOptions(), createLimiter);

            expect(createLimiter).toHaveBeenCalledTimes(3);
        });

        it('falls back to empty string when proxyUrls is undefined', () => {
            urlParser.parse.mockReturnValue(['http://proxy:8080']);

            provider.build(makeOptions({ proxyUrls: undefined }), createLimiter);

            expect(urlParser.parse).toHaveBeenCalledWith('');
        });
    });

    describe('validation & configuration errors', () => {
        it('delegates concurrency validation to assertPositiveInt', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            provider.build(makeOptions({ concurrency: 7 }), createLimiter);

            expect(assertPositiveInt).toHaveBeenCalledWith(7, 'concurrency');
        });

        it('throws ConfigurationError when poolConfig is missing', () => {
            expect(() => provider.build(makeOptions({ poolConfig: undefined }), createLimiter)).toThrow(
                ConfigurationError,
            );
        });

        it('throws ConfigurationError when urlParser returns an empty array', () => {
            urlParser.parse.mockReturnValue([]);

            expect(() => provider.build(makeOptions({ proxyUrls: '' }), createLimiter)).toThrow(
                new ConfigurationError('No valid proxy URLs were configured.'),
            );
        });

        it('throws when assertPositiveInt throws', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('concurrency must be a positive integer');
            });

            expect(() => provider.build(makeOptions({ concurrency: 0 }), createLimiter)).toThrow(
                'concurrency must be a positive integer',
            );
        });
    });

    describe('error handling & resource safety', () => {
        it('does not call urlParser.parse if assertPositiveInt throws', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('bad concurrency');
            });

            expect(() => provider.build(makeOptions({ concurrency: -1 }), createLimiter)).toThrow();

            expect(urlParser.parse).not.toHaveBeenCalled();
            expect(createLimiter).not.toHaveBeenCalled();
        });

        it('does not call createLimiter or transportFactory if urlParser returns empty', () => {
            urlParser.parse.mockReturnValue([]);

            expect(() => provider.build(makeOptions({ proxyUrls: '' }), createLimiter)).toThrow();

            expect(createLimiter).not.toHaveBeenCalled();
            expect(transportFactory.create).not.toHaveBeenCalled();
        });

        it('propagates error when createLimiter throws', () => {
            urlParser.parse.mockReturnValue(['http://p:1', 'http://p:2']);
            const err = new Error('limiter OOM');
            createLimiter.mockImplementation(() => {
                throw err;
            });

            expect(() => provider.build(makeOptions(), createLimiter)).toThrow(err);
        });

        it('propagates error when transportFactory.create throws', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);
            const err = new Error('transport init failed');
            transportFactory.create.mockImplementation(() => {
                throw err;
            });

            expect(() => provider.build(makeOptions(), createLimiter)).toThrow(err);
        });

        it('closes previously created endpoints when transportFactory.create throws mid-array', () => {
            const t0 = makeTransport();
            const limiter0 = makeLimiter();
            const limiter1 = makeLimiter();

            urlParser.parse.mockReturnValue(['http://p:1', 'http://p:2']);
            createLimiter.mockReturnValueOnce(limiter0).mockReturnValueOnce(limiter1);
            transportFactory.create.mockReturnValueOnce(t0).mockImplementationOnce(() => {
                throw new Error('transport failed');
            });

            expect(() => provider.build(makeOptions(), createLimiter)).toThrow('transport failed');

            // The first endpoint's transport was closed to prevent socket/timer leaks.
            expect(t0.close).toHaveBeenCalledTimes(1);
            // The second limiter was never used (iteration didn't complete).
            expect(limiter1.tryAcquire).not.toHaveBeenCalled();
        });

        it('closes previously created endpoints if createLimiter throws mid-array', () => {
            const t0 = makeTransport();
            const t1 = makeTransport();
            urlParser.parse.mockReturnValue(['a', 'b', 'c']);
            createLimiter
                .mockReturnValueOnce(makeLimiter())
                .mockReturnValueOnce(makeLimiter())
                .mockImplementationOnce(() => {
                    throw new Error('limiter failed');
                });
            transportFactory.create.mockReturnValueOnce(t0).mockReturnValueOnce(t1);

            expect(() => provider.build(makeOptions(), createLimiter)).toThrow('limiter failed');

            // Both successfully created endpoints had their transports closed.
            expect(t0.close).toHaveBeenCalledTimes(1);
            expect(t1.close).toHaveBeenCalledTimes(1);
            expect(transportFactory.create).toHaveBeenCalledTimes(3);
        });

        it('propagates error when urlParser.parse throws', () => {
            const err = new Error('malformed proxy URL');
            urlParser.parse.mockImplementation(() => {
                throw err;
            });

            expect(() => provider.build(makeOptions({ proxyUrls: 'bad' }), createLimiter)).toThrow(err);
        });
    });

    describe('constructor safety', () => {
        it('accepts undefined factories without throwing (defers failure)', () => {
            expect(
                () =>
                    new ProxyEndpointProvider(
                        undefined as unknown as ProxyTransportFactory,
                        undefined as unknown as ProxyUrlParser,
                    ),
            ).not.toThrow();
        });

        it('throws at build time when transportFactory is undefined', () => {
            const invalidProvider = new ProxyEndpointProvider(undefined as unknown as ProxyTransportFactory, urlParser);
            urlParser.parse.mockReturnValue(['x']);

            expect(() => invalidProvider.build(makeOptions(), createLimiter)).toThrow();
        });

        it('throws at build time when urlParser is undefined', () => {
            const invalidProvider = new ProxyEndpointProvider(transportFactory, undefined as unknown as ProxyUrlParser);

            expect(() => invalidProvider.build(makeOptions(), createLimiter)).toThrow();
        });
    });

    describe('idempotency & freshness', () => {
        it('returns new endpoint instances on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            const r1 = provider.build(makeOptions(), createLimiter);
            const r2 = provider.build(makeOptions(), createLimiter);

            expect(r1[0]).not.toBe(r2[0]);
            expect(createLimiter).toHaveBeenCalledTimes(2);
            expect(transportFactory.create).toHaveBeenCalledTimes(2);
        });

        it('re-parses proxyUrls on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            provider.build(makeOptions({ proxyUrls: 'a' }), createLimiter);
            provider.build(makeOptions({ proxyUrls: 'b' }), createLimiter);

            expect(urlParser.parse).toHaveBeenCalledTimes(2);
            expect(urlParser.parse).toHaveBeenNthCalledWith(1, 'a');
            expect(urlParser.parse).toHaveBeenNthCalledWith(2, 'b');
        });
    });

    describe('proxyCount correctness', () => {
        it('sets proxyCount equal to the number of parsed URLs', () => {
            const urls = ['a', 'b', 'c', 'd'];
            urlParser.parse.mockReturnValue(urls);

            provider.build(makeOptions({ concurrency: 2 }), createLimiter);

            const lastCall = transportFactory.create.mock.calls[3]!;
            const lastOptions = lastCall[1] as CreateProxyEndpointsOptions;
            expect(lastOptions.proxyCount).toBe(4);
        });
    });
});
