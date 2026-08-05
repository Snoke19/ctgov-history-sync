import { fetch, ProxyAgent } from 'undici';
import { HttpRequest, HttpResponse, HttpTransport } from '../types/transport.js';
import { TransportFactory } from '../types/transportFactory.js';
import { CreateProxyEndpointsOptions } from '../types/endpointOptions.js';
import { resolveConnections } from '../proxy/resolveConnections.js';
import { createPoolFactory } from '../../poolFactory.js';

/**
 * Undici ProxyAgent adapter for the universal {@link HttpTransport}.
 *
 * If SOCKS via undici is needed in the future, you can:
 *   1. Use a third-party agent (e.g., socks-proxy-agent)
 *      inside this factory, selecting it based on `options.proxyType`.
 *   2. Or create a separate `SocksTransportFactory` and wire
 *      it at the composition level (via `CompositeTransportFactory`).
 */
export class UndiciHttpTransport implements HttpTransport {
    constructor(private readonly agent: ProxyAgent) {}

    async request(options: HttpRequest): Promise<HttpResponse> {
        const response = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            dispatcher: this.agent,
            ...(options.body !== undefined && { body: options.body }),
            ...(options.signal !== undefined && { signal: options.signal }),
        });

        return {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers: response.headers,
            text: () => response.text(),
            json: <T>() => response.json() as Promise<T>,
            discard: async () => {
                if (response.body) {
                    await (response.body as ReadableStream).cancel().catch(() => {});
                }
            },
        };
    }

    close(): Promise<void> {
        return this.agent.close();
    }
}

export class UndiciTransportFactory implements TransportFactory {
    create(proxyUrl: string, options: CreateProxyEndpointsOptions): HttpTransport {
        const connections = resolveConnections(
            options.proxyCount,
            options.concurrency,
            options.poolConfig,
        );
        const poolFactory = createPoolFactory(options.poolConfig);

        const agent = new ProxyAgent({
            uri: proxyUrl,
            clientFactory: (origin, opts) => poolFactory(origin, { ...opts, connections }),
        });

        return new UndiciHttpTransport(agent);
    }
}
