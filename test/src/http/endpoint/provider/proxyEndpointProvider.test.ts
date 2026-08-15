import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigurationError } from '../../../../../src/error/errors.js';
import { ProxyEndpointProviderOptions } from '../../../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js';
import { ProxyUrlParser } from '../../../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { ProxyTransportContext, ProxyTransportFactory } from '../../../../../src/http/transport/factory/proxyTransportFactory.js';
import { HttpTransport } from '../../../../../src/http/transport/httpTransport.js';
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
    let provider: InstanceType<typeof ProxyEndpointProvider>;

    const makeTransport = (): HttpTransport =>
        ({ close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) }) as unknown as HttpTransport;

    const makeOptions = (overrides: Partial<ProxyEndpointProviderOptions> = {}): ProxyEndpointProviderOptions => ({
        concurrency: 1,
        proxyUrls: 'http://proxy:8080',
        ...overrides,
    });

    const makeProvider = (options: ProxyEndpointProviderOptions = makeOptions()): InstanceType<typeof ProxyEndpointProvider> =>
        new ProxyEndpointProvider(transportFactory, urlParser, options);

    beforeEach(() => {
        jest.clearAllMocks();
        assertPositiveInt.mockImplementation(() => {});

        transportFactory = { create: jest.fn() } as unknown as jest.Mocked<ProxyTransportFactory>;
        urlParser = { parse: jest.fn() } as unknown as jest.Mocked<ProxyUrlParser>;
        transportFactory.create.mockImplementation(makeTransport);

        provider = makeProvider();
    });

    describe('happy path', () => {
        it('returns one definition per parsed proxy URL, keyed by the URL', () => {
            const urls = ['http://proxy1:8080', 'http://proxy2:8080'];
            urlParser.parse.mockReturnValue(urls);

            const result = makeProvider(makeOptions({ proxyUrls: urls.join(',') })).build();

            expect(result.map((d) => d.id)).toEqual(urls);
        });

        it('does not create transports during build() — creation is deferred to createTransport', () => {
            urlParser.parse.mockReturnValue(['http://proxy1:8080']);

            provider.build();

            expect(transportFactory.create).not.toHaveBeenCalled();
        });

        it('passes the correct ProxyTransportContext to the transport factory on createTransport', () => {
            urlParser.parse.mockReturnValue(['socks5://proxy:1080']);

            const [definition] = makeProvider(
                makeOptions({
                    concurrency: 3,
                    proxyUrls: 'socks5://proxy:1080',
                }),
            ).build();

            definition!.createTransport();

            expect(transportFactory.create).toHaveBeenCalledWith(
                'socks5://proxy:1080',
                expect.objectContaining({
                    concurrency: 3,
                    proxyCount: 1,
                }),
            );
        });

        it('does not include pool configuration in the transport context', () => {
            urlParser.parse.mockReturnValue(['socks5://proxy:1080']);

            const [definition] = makeProvider(makeOptions({ concurrency: 3 })).build();

            definition!.createTransport();

            expect(transportFactory.create.mock.calls[0]![1]).toEqual({
                concurrency: 3,
                proxyCount: 1,
            });
        });

        it('creates each proxy transport with its own URL', () => {
            const urls = ['http://a:1', 'http://b:2'];
            urlParser.parse.mockReturnValue(urls);

            const definitions = makeProvider(makeOptions({ proxyUrls: urls.join(',') })).build();
            definitions.forEach((d) => d.createTransport());

            expect(transportFactory.create).toHaveBeenNthCalledWith(1, 'http://a:1', expect.any(Object));
            expect(transportFactory.create).toHaveBeenNthCalledWith(2, 'http://b:2', expect.any(Object));
        });

        it('parses the configured proxyUrls', () => {
            urlParser.parse.mockReturnValue(['http://proxy:8080']);

            makeProvider(makeOptions({ proxyUrls: 'http://configured-proxy:8080' })).build();

            expect(urlParser.parse).toHaveBeenCalledWith('http://configured-proxy:8080');
        });
    });

    describe('validation & configuration errors', () => {
        it('delegates concurrency validation to assertPositiveInt', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            makeProvider(makeOptions({ concurrency: 7 })).build();

            expect(assertPositiveInt).toHaveBeenCalledWith(7, 'concurrency');
        });

        it('throws ConfigurationError when urlParser returns an empty array', () => {
            urlParser.parse.mockReturnValue([]);

            expect(() => makeProvider(makeOptions({ proxyUrls: '' })).build()).toThrow(
                new ConfigurationError('No valid proxy URLs were configured.'),
            );
        });

        it('throws when assertPositiveInt throws', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('concurrency must be a positive integer');
            });

            expect(() => makeProvider(makeOptions({ concurrency: 0 })).build()).toThrow(
                'concurrency must be a positive integer',
            );
        });

        it('does not call urlParser.parse if assertPositiveInt throws', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('bad concurrency');
            });

            expect(() => makeProvider(makeOptions({ concurrency: -1 })).build()).toThrow();

            expect(urlParser.parse).not.toHaveBeenCalled();
        });

        it('propagates error when urlParser.parse throws', () => {
            const err = new Error('malformed proxy URL');
            urlParser.parse.mockImplementation(() => {
                throw err;
            });

            expect(() => makeProvider(makeOptions({ proxyUrls: 'bad' })).build()).toThrow(err);
        });
    });

    describe('error handling & resource safety', () => {
        it('throws at build time when urlParser is undefined', () => {
            const invalidProvider = new ProxyEndpointProvider(
                transportFactory,
                undefined as unknown as ProxyUrlParser,
                makeOptions(),
            );

            expect(() => invalidProvider.build()).toThrow();
        });

        it('defers a missing transportFactory failure to createTransport time', () => {
            const invalidProvider = new ProxyEndpointProvider(
                undefined as unknown as ProxyTransportFactory,
                urlParser,
                makeOptions(),
            );
            urlParser.parse.mockReturnValue(['x']);

            const [definition] = invalidProvider.build();

            expect(() => definition!.createTransport()).toThrow();
        });

        it('propagates error when transportFactory.create throws on createTransport', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);
            const err = new Error('transport init failed');
            transportFactory.create.mockImplementation(() => {
                throw err;
            });

            const [definition] = provider.build();

            expect(() => definition!.createTransport()).toThrow(err);
        });
    });

    describe('idempotency & freshness', () => {
        it('returns fresh definition instances on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            const r1 = provider.build();
            const r2 = provider.build();

            expect(r1[0]).not.toBe(r2[0]);
        });

        it('re-parses proxyUrls on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            provider.build();
            provider.build();

            expect(urlParser.parse).toHaveBeenCalledTimes(2);
            expect(urlParser.parse).toHaveBeenNthCalledWith(1, 'http://proxy:8080');
            expect(urlParser.parse).toHaveBeenNthCalledWith(2, 'http://proxy:8080');
        });
    });

    describe('proxyCount correctness', () => {
        it('sets proxyCount equal to the number of parsed URLs', () => {
            const urls = ['a', 'b', 'c', 'd'];
            urlParser.parse.mockReturnValue(urls);

            const definitions = makeProvider(makeOptions({ concurrency: 2 })).build();
            definitions.forEach((d) => d.createTransport());

            const lastCall = transportFactory.create.mock.calls[3]!;
            const lastContext = lastCall[1] as ProxyTransportContext;
            expect(lastContext.proxyCount).toBe(4);
        });
    });
});