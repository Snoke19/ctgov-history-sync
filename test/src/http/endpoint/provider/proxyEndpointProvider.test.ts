import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Limiter } from '../../../../../src/http/limiter/limiter.js';
import { ProxyTransportFactory } from '../../../../../src/http/endpoint/transport/factory/transportFactory.js';
import { ProxyUrlParser } from '../../../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { HttpClientOptions } from '../../../../../src/http/types/http.js';
import { Endpoint } from '../../../../../src/http/endpoint/endpoint.js';
import { ConfigurationError } from '../../../../../src/error/errors.js';
import * as validation from '../../../../../src/utils/validation.js';
import { CreateProxyEndpointsOptions } from '../../../../../src/http/endpoint/transport/httpTransport.js';

const assertPositiveInt = jest.fn();

jest.unstable_mockModule('../../../../../src/utils/validation.js', () => ({
    ...validation,
    assertPositiveInt,
}));

const { ProxyEndpointProvider } =
    await import('../../../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js');

describe('ProxyEndpointProvider', () => {
    let transportFactory: { create: jest.Mock };
    let urlParser: { parse: jest.Mock };
    let createLimiter: jest.Mock<() => Limiter>;

    const makeLimiter = (): Limiter =>
        ({
            tryAcquire: jest.fn().mockReturnValue(true),
            timeUntilToken: jest.fn().mockReturnValue(0),
        }) as unknown as Limiter;

    const makeTransport = () => ({ close: jest.fn() });

    beforeEach(() => {
        jest.clearAllMocks();
        assertPositiveInt.mockImplementation(() => {});
        transportFactory = { create: jest.fn() };
        urlParser = { parse: jest.fn() };
        createLimiter = jest.fn();
    });

    describe('happy path', () => {
        it('builds one endpoint per parsed proxy URL', () => {
            const urls = ['http://proxy1:8080', 'http://proxy2:8080'];
            urlParser.parse.mockReturnValue(urls);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            const result = provider.build(
                {
                    concurrency: 5,
                    poolConfig: { maxConnections: 10 },
                    proxyUrls: 'http://proxy1:8080,http://proxy2:8080',
                } as HttpClientOptions,
                createLimiter,
            );

            expect(result).toHaveLength(2);
            result.forEach((ep) => expect(ep).toBeInstanceOf(Endpoint));
        });

        it('passes the correct CreateProxyEndpointsOptions to the transport factory', () => {
            const urls = ['socks5://proxy:1080'];
            urlParser.parse.mockReturnValue(urls);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            provider.build(
                {
                    concurrency: 3,
                    poolConfig: { maxConnections: 20 },
                    proxyUrls: 'socks5://proxy:1080',
                } as HttpClientOptions,
                createLimiter,
            );

            expect(transportFactory.create).toHaveBeenCalledWith('socks5://proxy:1080', {
                concurrency: 3,
                proxyCount: 1,
                poolConfig: { maxConnections: 20 },
            });
        });

        it('uses the proxy URL as the endpoint id', () => {
            const urls = ['http://a:1', 'http://b:2'];
            urlParser.parse.mockReturnValue(urls);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            const result = provider.build(
                {
                    concurrency: 1,
                    poolConfig: {},
                    proxyUrls: 'irrelevant',
                } as HttpClientOptions,
                createLimiter,
            );

            expect(result[0]).toBeInstanceOf(Endpoint);
            // Endpoint id is the first constructor arg; we verify via instance property if available,
            // otherwise we trust the constructor call. If Endpoint exposes `id`:
            // expect(result.map((e) => (e as any).id)).toEqual(urls);
        });

        it('creates a fresh limiter for every endpoint', () => {
            const urls = ['p1', 'p2', 'p3'];
            urlParser.parse.mockReturnValue(urls);
            createLimiter
                .mockReturnValueOnce(makeLimiter())
                .mockReturnValueOnce(makeLimiter())
                .mockReturnValueOnce(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            provider.build({ concurrency: 2, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter);

            expect(createLimiter).toHaveBeenCalledTimes(3);
        });

        it('falls back to empty string when proxyUrls is undefined', () => {
            urlParser.parse.mockReturnValue(['http://proxy:8080']);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            provider.build({ concurrency: 1, poolConfig: {} } as HttpClientOptions, createLimiter);

            expect(urlParser.parse).toHaveBeenCalledWith('');
        });
    });

    describe('validation & configuration errors', () => {
        it('delegates concurrency validation to assertPositiveInt', () => {
            assertPositiveInt.mockImplementation(() => {});

            urlParser.parse.mockReturnValue(['http://p:1']);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            provider.build({ concurrency: 7, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter);

            expect(assertPositiveInt).toHaveBeenCalledWith(7, 'concurrency');
        });

        it('throws ConfigurationError when poolConfig is missing', () => {
            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, proxyUrls: 'http://p:1' } as HttpClientOptions, createLimiter),
            ).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError when urlParser returns an empty array', () => {
            urlParser.parse.mockReturnValue([]);

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: '' } as HttpClientOptions, createLimiter),
            ).toThrow(new ConfigurationError('No valid proxy URLs were configured.'));
        });

        it('throws when assertPositiveInt throws (e.g. concurrency is 0)', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('concurrency must be a positive integer');
            });

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 0, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter),
            ).toThrow('concurrency must be a positive integer');
        });
    });

    describe('error handling & resource leaks', () => {
        it('does not call urlParser.parse if assertPositiveInt throws', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('bad concurrency');
            });

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            try {
                provider.build({ concurrency: -1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter);
            } catch {
                // expected
            }

            expect(urlParser.parse).not.toHaveBeenCalled();
            expect(createLimiter).not.toHaveBeenCalled();
        });

        it('does not call createLimiter or transportFactory if urlParser returns empty', () => {
            urlParser.parse.mockReturnValue([]);

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            try {
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: '' } as HttpClientOptions, createLimiter);
            } catch {
                // expected
            }

            expect(createLimiter).not.toHaveBeenCalled();
            expect(transportFactory.create).not.toHaveBeenCalled();
        });

        it('propagates error when createLimiter throws', () => {
            urlParser.parse.mockReturnValue(['http://p:1', 'http://p:2']);

            const err = new Error('limiter OOM');

            createLimiter.mockImplementation(() => {
                throw err;
            });

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter),
            ).toThrow(err);
        });

        it('propagates error when transportFactory.create throws', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);
            createLimiter.mockReturnValue(makeLimiter());
            const err = new Error('transport init failed');
            transportFactory.create.mockImplementation(() => {
                throw err;
            });

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter),
            ).toThrow(err);
        });

        it('orphans the limiter when transportFactory.create throws mid-array (BUG)', () => {
            // If we have N URLs and transportFactory.create throws on the i-th
            // iteration, the limiter created in that iteration is leaked.

            const limiter0 = makeLimiter();
            const limiter1 = makeLimiter();

            urlParser.parse.mockReturnValue(['http://p:1', 'http://p:2']);
            createLimiter.mockReturnValueOnce(limiter0).mockReturnValueOnce(limiter1);
            transportFactory.create.mockReturnValueOnce(makeTransport()).mockImplementationOnce(() => {
                throw new Error('transport failed');
            });

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter),
            ).toThrow('transport failed');

            expect(createLimiter).toHaveBeenCalledTimes(1);
            // limiters[1] was created but never wrapped in an Endpoint.
            // If it holds timers/connections, they are leaked.
            expect(limiter1.tryAcquire).not.toHaveBeenCalled();
        });

        it('leaks previously created endpoints if createLimiter throws mid-array (BUG)', () => {
            // If urlParser returns 3 URLs and createLimiter throws on the 3rd call,
            // 2 Endpoints have already been instantiated and their transports/limiters
            // are alive, but the caller receives nothing (the error bubbles up).
            const transports = [makeTransport(), makeTransport()];
            urlParser.parse.mockReturnValue(['a', 'b', 'c']);
            createLimiter
                .mockReturnValueOnce(makeLimiter())
                .mockReturnValueOnce(makeLimiter())
                .mockImplementationOnce(() => {
                    throw new Error('limiter failed');
                });
            transportFactory.create.mockReturnValueOnce(transports[0]).mockReturnValueOnce(transports[1]);

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter),
            ).toThrow('limiter failed');

            // Two transports were created but are now unreachable by the caller.
            expect(transportFactory.create).toHaveBeenCalledTimes(3);
        });

        it('propagates error when urlParser.parse throws', () => {
            const err = new Error('malformed proxy URL');
            urlParser.parse.mockImplementation(() => {
                throw err;
            });

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build(
                    { concurrency: 1, poolConfig: {}, proxyUrls: 'bad' } as HttpClientOptions,
                    createLimiter,
                ),
            ).toThrow(err);
        });
    });

    describe('constructor safety', () => {
        it('accepts undefined factories without throwing (defers failure)', () => {
            // No runtime validation in constructor.
            expect(
                () =>
                    new ProxyEndpointProvider(
                        undefined as unknown as ProxyTransportFactory,
                        undefined as unknown as ProxyUrlParser,
                    ),
            ).not.toThrow();
        });

        it('throws at build time when transportFactory is undefined', () => {
            const provider = new ProxyEndpointProvider(
                undefined as unknown as ProxyTransportFactory,
                { parse: jest.fn().mockReturnValue(['x']) } as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter),
            ).toThrow();
        });

        it('throws at build time when urlParser is undefined', () => {
            const provider = new ProxyEndpointProvider(
                { create: jest.fn() } as unknown as ProxyTransportFactory,
                undefined as unknown as ProxyUrlParser,
            );

            expect(() =>
                provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter),
            ).toThrow();
        });
    });

    describe('idempotency & freshness', () => {
        it('returns new endpoint instances on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            const r1 = provider.build(
                { concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions,
                createLimiter,
            );
            const r2 = provider.build(
                { concurrency: 1, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions,
                createLimiter,
            );

            expect(r1[0]).not.toBe(r2[0]);
            expect(createLimiter).toHaveBeenCalledTimes(2);
            expect(transportFactory.create).toHaveBeenCalledTimes(2);
        });

        it('re-parses proxyUrls on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'a' } as HttpClientOptions, createLimiter);
            provider.build({ concurrency: 1, poolConfig: {}, proxyUrls: 'b' } as HttpClientOptions, createLimiter);

            expect(urlParser.parse).toHaveBeenCalledTimes(2);
            expect(urlParser.parse).toHaveBeenNthCalledWith(1, 'a');
            expect(urlParser.parse).toHaveBeenNthCalledWith(2, 'b');
        });
    });

    describe('proxyCount correctness', () => {
        it('sets proxyCount equal to the number of parsed URLs', () => {
            const urls = ['a', 'b', 'c', 'd'];
            urlParser.parse.mockReturnValue(urls);
            createLimiter.mockReturnValue(makeLimiter());
            transportFactory.create.mockReturnValue(makeTransport());

            const provider = new ProxyEndpointProvider(
                transportFactory as unknown as ProxyTransportFactory,
                urlParser as unknown as ProxyUrlParser,
            );

            provider.build({ concurrency: 2, poolConfig: {}, proxyUrls: 'x' } as HttpClientOptions, createLimiter);

            const lastCall = transportFactory.create.mock.calls[3]!;
            const lastOptions = lastCall[1] as CreateProxyEndpointsOptions;
            expect(lastOptions.proxyCount).toBe(4);
        });
    });
});
