import { fetch, ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { ProxyPoolConfig } from '../../../../config/config.js';
import { createPoolFactory } from '../../../poolFactory.js';
import { resolveConnections } from '../../proxy/resolveConnections.js';
import { ProxyTransportFactory } from '../factory/proxyTransportFactory.js';
import { CreateProxyEndpointsOptions, HttpRequest, HttpResponse, HttpTransport } from '../httpTransport.js';

/** Creates a Dispatcher pool for a given origin. Called by ProxyAgent per-origin. */
export type PoolClientFactory = (origin: URL, opts?: Record<string, unknown>) => Dispatcher;

/** Transforms pool config into a PoolClientFactory. */
export type PoolCreatorFn = (config: ProxyPoolConfig) => PoolClientFactory;

/** Assembles a ProxyAgent from a URI and clientFactory. */
export type AgentCreatorFn = (uri: string, clientFactory: PoolClientFactory) => ProxyAgent;

/**
 * Undici ProxyAgent adapter implementing the universal {@link HttpTransport}.
 *
 * Each instance owns a single ProxyAgent. The agent is closed on shutdown
 * to release underlying sockets and timers.
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

        return this.toHttpResponse(response);
    }

    close(): Promise<void> {
        return this.agent.close();
    }

    private toHttpResponse(response: Awaited<ReturnType<typeof fetch>>): HttpResponse {
        return {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers: response.headers,
            text: () => response.text(),
            json: () => response.json(),
            discard: async () => {
                if (response.body) {
                    await (response.body as ReadableStream).cancel().catch(() => {});
                }
            },
        };
    }
}

/**
 * Factory that produces {@link UndiciHttpTransport} instances wired to a
 * specific proxy URL and shared pool configuration.
 *
 * This class is the **only** place in the endpoint layer that knows about
 * undici. Constructor parameters are test seams:
 *
 *   - `poolCreator`  – stub to avoid creating real TCP pools.
 *   - `agentCreator` – stub to avoid real proxy handshakes.
 */
export class UndiciTransportFactory implements ProxyTransportFactory {
    constructor(
        private readonly poolCreator: PoolCreatorFn = createPoolFactory,
        private readonly agentCreator: AgentCreatorFn = defaultAgentCreator,
    ) {}

    create(proxyUrl: string, options: CreateProxyEndpointsOptions): HttpTransport {
        const connections = resolveConnections(options.proxyCount, options.concurrency, options.poolConfig);
        const poolFactory = this.poolCreator(options.poolConfig);

        const clientFactory: PoolClientFactory = (origin, opts) =>
            poolFactory(origin, { ...opts, connections } as Parameters<typeof poolFactory>[1]);

        const agent = this.agentCreator(proxyUrl, clientFactory);

        return new UndiciHttpTransport(agent);
    }
}

function defaultAgentCreator(uri: string, clientFactory: PoolClientFactory): ProxyAgent {
    return new ProxyAgent({ uri, clientFactory: clientFactory as (origin: URL, opts: object) => Dispatcher });
}
