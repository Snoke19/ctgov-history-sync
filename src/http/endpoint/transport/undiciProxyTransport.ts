import { fetch, ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import {
    CreateProxyEndpointsOptions,
    HttpRequest,
    HttpResponse,
    HttpTransport,
} from './transport.js';
import { TransportFactory } from './factory/transportFactory.js';
import { ProxyPoolConfig } from '../../../config/config.js';
import { resolveConnections } from '../proxy/resolveConnections.js';
import { createPoolFactory } from '../../poolFactory.js';
// ─── Injectable seam types ────────────────────────────────────────────────────
//
// These types define the boundary between UndiciTransportFactory and the
// underlying connection pool / agent infrastructure. They are exported so
// tests can construct fully-typed fakes without resorting to `any` casts.
//
// PoolClientFactory: the function ProxyAgent calls per-origin to obtain a pool.
// PoolCreatorFn:     transforms pool config into a PoolClientFactory.
// AgentCreatorFn:    assembles a ProxyAgent from a URI + clientFactory.
//
// In production these defaults wire real undici objects. In tests, inject
// stubs to avoid real socket creation and proxy handshakes.
// ─────────────────────────────────────────────────────────────────────────────
export type PoolClientFactory = (origin: URL, opts?: Record<string, any>) => Dispatcher;
export type PoolCreatorFn = (config: ProxyPoolConfig) => PoolClientFactory;
export type AgentCreatorFn = (uri: string, clientFactory: PoolClientFactory) => ProxyAgent;

const defaultAgentCreator: AgentCreatorFn = (uri, clientFactory) =>
    new ProxyAgent({ uri, clientFactory });

/**
 * Undici ProxyAgent adapter implementing the universal {@link HttpTransport}.
 *
 * Each instance owns a single ProxyAgent. The agent is closed on shutdown
 * to release underlying sockets and timers.
 *
 * To add SOCKS support, create a separate `SocksHttpTransport` and a matching
 * `SocksTransportFactory`, then inject the appropriate factory into
 * `ProxyEndpointProvider` at the composition root.
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

/**
 * Factory that produces {@link UndiciHttpTransport} instances wired to a
 * specific proxy URL and shared pool configuration.
 *
 * This class is the **only** place in the endpoint layer that knows about
 * undici. It is injected into `ProxyEndpointProvider`, which in turn is
 * injected into `EndpointFactory` at the composition root.
 *
 * The two constructor parameters are **test seams**:
 *
 *   - `poolCreator`  – Replace with a stub to avoid creating real TCP pools.
 *   - `agentCreator` – Replace with a stub to avoid real proxy handshakes.
 *
 * Both default to production undici implementations.
 */
export class UndiciTransportFactory implements TransportFactory {
    constructor(
        private readonly poolCreator: PoolCreatorFn = createPoolFactory,
        private readonly agentCreator: AgentCreatorFn = defaultAgentCreator,
    ) {}

    create(proxyUrl: string, options: CreateProxyEndpointsOptions): HttpTransport {
        const connections = resolveConnections(
            options.proxyCount,
            options.concurrency,
            options.poolConfig,
        );

        const poolFactory = this.poolCreator(options.poolConfig);

        const clientFactory: PoolClientFactory = (origin, opts) =>
            poolFactory(origin, { ...opts, connections });

        const agent = this.agentCreator(proxyUrl, clientFactory);

        return new UndiciHttpTransport(agent);
    }
}
