import { fetch, ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { ProxyPoolConfig } from '../../../config/config.js';
import { resolveConnections } from '../../endpoint/proxy/resolveConnections.js';
import { createPoolFactory } from '../../poolFactory.js';
import { adaptHttpResponse } from '../adaptHttpResponse.js';
import { classifyTransportError } from '../classifyTransportError.js';
import { ProxyTransportFactory } from '../factory/proxyTransportFactory.js';
import type {
    CreateProxyEndpointsOptions,
    HttpRequest,
    HttpResponse,
    HttpTransport,
    TransportErrorClassification,
} from '../httpTransport.js';

export type PoolClientFactory = (origin: URL, opts?: Record<string, unknown>) => Dispatcher;
export type PoolCreatorFn = (config: ProxyPoolConfig) => PoolClientFactory;
export type AgentCreatorFn = (uri: string, clientFactory: PoolClientFactory) => ProxyAgent;

export class UndiciHttpTransport implements HttpTransport {
    constructor(private readonly agent: ProxyAgent) {}

    async request(options: HttpRequest): Promise<HttpResponse> {
        const response = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            dispatcher: this.agent,
            signal: options.signal,
        });

        return adaptHttpResponse(response);
    }

    classifyError(error: unknown): TransportErrorClassification {
        return classifyTransportError(error);
    }

    close(): Promise<void> {
        return this.agent.close();
    }
}

export class UndiciTransportFactory implements ProxyTransportFactory {
    constructor(
        private readonly poolCreator: PoolCreatorFn = createPoolFactory,
        private readonly agentCreator: AgentCreatorFn = defaultAgentCreator,
    ) {}

    create(proxyUrl: string, options: CreateProxyEndpointsOptions): HttpTransport {
        const connections = resolveConnections(options.proxyCount, options.concurrency, options.poolConfig);

        const poolFactory = this.poolCreator(options.poolConfig);

        const clientFactory: PoolClientFactory = (origin, opts) =>
            poolFactory(origin, {
                ...opts,
                connections,
            } as Parameters<typeof poolFactory>[1]);

        const agent = this.agentCreator(proxyUrl, clientFactory);

        return new UndiciHttpTransport(agent);
    }
}

function defaultAgentCreator(uri: string, clientFactory: PoolClientFactory): ProxyAgent {
    return new ProxyAgent({
        uri,
        clientFactory: clientFactory as (origin: URL, opts: object) => Dispatcher,
    });
}
