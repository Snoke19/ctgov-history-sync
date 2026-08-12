import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProxyPoolConfig } from '../../../../../src/config/config.js';
import { ConfigurationError } from '../../../../../src/error/errors.js';
import { ProxyUrlParser } from '../../../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { ProxyTransportFactory } from '../../../../../src/http/endpoint/transport/factory/proxyTransportFactory.js';
import {
    CreateProxyEndpointsOptions,
    HttpTransport,
} from '../../../../../src/http/endpoint/transport/httpTransport.js';
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
    let provider: InstanceType<typeof ProxyEndpointProvider>;

    const makeTransport = (): HttpTransport =>
        ({ close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) }) as unknown as HttpTransport;

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
        transportFactory.create.mockImplementation(makeTransport);

        provider = new ProxyEndpointProvider(transportFactory, urlParser);
    });

    describe('happy path', () => {
        it('returns one definition per parsed proxy URL, keyed by the URL', () => {
            const urls = ['http://proxy1:8080', 'http://proxy2:8080'];
            urlParser.parse.mockReturnValue(urls);

            const result = provider.build(makeOptions({ proxyUrls: urls.join(',') }));

            expect(result.map((d) => d.id)).toEqual(urls);
        });

        it('does not create transports during build() — creation is deferred to createTransport', () => {
            urlParser.parse.mockReturnValue(['http://proxy1:8080']);

            provider.build(makeOptions());

            expect(transportFactory.create).not.toHaveBeenCalled();
        });

        it('passes the correct CreateProxyEndpointsOptions to the transport factory on createTransport', () => {
            urlParser.parse.mockReturnValue(['socks5://proxy:1080']);

            const [definition] = provider.build(
                makeOptions({
                    concurrency: 3,
                    poolConfig: { maxConnections: 20 },
                    proxyUrls: 'socks5://proxy:1080',
                }),
            );

            definition!.createTransport();

            expect(transportFactory.create).toHaveBeenCalledWith(
                'socks5://proxy:1080',
                expect.objectContaining({
                    concurrency: 3,
                    proxyCount: 1,
                    poolConfig: { maxConnections: 20 },
                }),
            );
        });

        it('creates each proxy transport with its own URL', () => {
            const urls = ['http://a:1', 'http://b:2'];
            urlParser.parse.mockReturnValue(urls);

            const definitions = provider.build(makeOptions());
            definitions.forEach((d) => d.createTransport());

            expect(transportFactory.create).toHaveBeenNthCalledWith(1, 'http://a:1', expect.any(Object));
            expect(transportFactory.create).toHaveBeenNthCalledWith(2, 'http://b:2', expect.any(Object));
        });

        it('falls back to empty string when proxyUrls is undefined', () => {
            urlParser.parse.mockReturnValue(['http://proxy:8080']);

            provider.build(makeOptions({ proxyUrls: undefined }));

            expect(urlParser.parse).toHaveBeenCalledWith('');
        });
    });

    describe('validation & configuration errors', () => {
        it('delegates concurrency validation to assertPositiveInt', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            provider.build(makeOptions({ concurrency: 7 }));

            expect(assertPositiveInt).toHaveBeenCalledWith(7, 'concurrency');
        });

        it('throws ConfigurationError when poolConfig is missing', () => {
            expect(() => provider.build(makeOptions({ poolConfig: undefined }))).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError when urlParser returns an empty array', () => {
            urlParser.parse.mockReturnValue([]);

            expect(() => provider.build(makeOptions({ proxyUrls: '' }))).toThrow(
                new ConfigurationError('No valid proxy URLs were configured.'),
            );
        });

        it('throws when assertPositiveInt throws', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('concurrency must be a positive integer');
            });

            expect(() => provider.build(makeOptions({ concurrency: 0 }))).toThrow(
                'concurrency must be a positive integer',
            );
        });

        it('does not call urlParser.parse if assertPositiveInt throws', () => {
            assertPositiveInt.mockImplementation(() => {
                throw new Error('bad concurrency');
            });

            expect(() => provider.build(makeOptions({ concurrency: -1 }))).toThrow();

            expect(urlParser.parse).not.toHaveBeenCalled();
        });

        it('propagates error when urlParser.parse throws', () => {
            const err = new Error('malformed proxy URL');
            urlParser.parse.mockImplementation(() => {
                throw err;
            });

            expect(() => provider.build(makeOptions({ proxyUrls: 'bad' }))).toThrow(err);
        });
    });

    describe('error handling & resource safety', () => {
        it('throws at build time when urlParser is undefined', () => {
            const invalidProvider = new ProxyEndpointProvider(transportFactory, undefined as unknown as ProxyUrlParser);

            expect(() => invalidProvider.build(makeOptions())).toThrow();
        });

        it('defers a missing transportFactory failure to createTransport time', () => {
            const invalidProvider = new ProxyEndpointProvider(
                undefined as unknown as ProxyTransportFactory,
                urlParser,
            );
            urlParser.parse.mockReturnValue(['x']);

            const [definition] = invalidProvider.build(makeOptions());

            expect(() => definition!.createTransport()).toThrow();
        });

        it('propagates error when transportFactory.create throws on createTransport', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);
            const err = new Error('transport init failed');
            transportFactory.create.mockImplementation(() => {
                throw err;
            });

            const [definition] = provider.build(makeOptions());

            expect(() => definition!.createTransport()).toThrow(err);
        });
    });

    describe('idempotency & freshness', () => {
        it('returns fresh definition instances on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            const r1 = provider.build(makeOptions());
            const r2 = provider.build(makeOptions());

            expect(r1[0]).not.toBe(r2[0]);
        });

        it('re-parses proxyUrls on every build call', () => {
            urlParser.parse.mockReturnValue(['http://p:1']);

            provider.build(makeOptions({ proxyUrls: 'a' }));
            provider.build(makeOptions({ proxyUrls: 'b' }));

            expect(urlParser.parse).toHaveBeenCalledTimes(2);
            expect(urlParser.parse).toHaveBeenNthCalledWith(1, 'a');
            expect(urlParser.parse).toHaveBeenNthCalledWith(2, 'b');
        });
    });

    describe('proxyCount correctness', () => {
        it('sets proxyCount equal to the number of parsed URLs', () => {
            const urls = ['a', 'b', 'c', 'd'];
            urlParser.parse.mockReturnValue(urls);

            const definitions = provider.build(makeOptions({ concurrency: 2 }));
            definitions.forEach((d) => d.createTransport());

            const lastCall = transportFactory.create.mock.calls[3]!;
            const lastOptions = lastCall[1] as CreateProxyEndpointsOptions;
            expect(lastOptions.proxyCount).toBe(4);
        });
    });
});