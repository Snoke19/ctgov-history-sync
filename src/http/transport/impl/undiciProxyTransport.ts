import { fetch, Pool, ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { ProxyPoolConfig } from '../../../config/config.js';
import { createLogger } from '../../../config/logging.js';
import { resolveConnections } from '../../endpoint/proxy/resolveConnections.js';
import { adaptHttpResponse } from '../adaptHttpResponse.js';
import { classifyTransportError } from '../classifyTransportError.js';
import { ProxyTransportContext, ProxyTransportFactory } from '../factory/proxyTransportFactory.js';
import type { HttpRequest, HttpResponse, HttpTransport, TransportErrorClassification } from '../httpTransport.js';

const logger = createLogger(import.meta.url);

export type PoolClientFactory = (origin: URL, opts?: Record<string, unknown>) => Dispatcher;
export type PoolCreatorFn = (config: ProxyPoolConfig) => PoolClientFactory;
export type AgentCreatorFn = (uri: string, clientFactory: PoolClientFactory) => ProxyAgent;

export interface UndiciTransportFactoryOptions {
    readonly poolConfig: Readonly<ProxyPoolConfig>;
    readonly poolCreator?: PoolCreatorFn;
    readonly agentCreator?: AgentCreatorFn;
}

export class UndiciHttpTransport implements HttpTransport {
    constructor(
        private readonly agent: ProxyAgent,
        private readonly proxyUrl?: string,
    ) {}

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

    async close(): Promise<void> {
        try {
            await this.agent.close();
            logger.debug(
                { proxy: this.proxyUrl ? sanitizeProxyUrl(this.proxyUrl) : null },
                'Proxy transport closed',
            );
        } catch (error: unknown) {
            logger.error(
                { proxy: this.proxyUrl ? sanitizeProxyUrl(this.proxyUrl) : null, err: error },
                'Failed to close proxy transport',
            );
            throw error;
        }
    }
}

export class UndiciTransportFactory implements ProxyTransportFactory {
    constructor(private readonly options: UndiciTransportFactoryOptions) {}

    create(proxyUrl: string, context: ProxyTransportContext): HttpTransport {
        const poolCreator = this.options.poolCreator ?? createPoolFactory;
        const agentCreator = this.options.agentCreator ?? defaultAgentCreator;

        const connections = resolveConnections(context.proxyCount, context.concurrency, this.options.poolConfig);

        const poolFactory = poolCreator(this.options.poolConfig);

        const clientFactory: PoolClientFactory = (origin, opts) =>
            poolFactory(origin, {
                ...opts,
                connections,
            } as Parameters<typeof poolFactory>[1]);

        const agent = agentCreator(proxyUrl, clientFactory);

        logger.debug(
            { proxyUrl: sanitizeProxyUrl(proxyUrl), connections, proxyCount: context.proxyCount },
            'Proxy transport created',
        );

        return new UndiciHttpTransport(agent, proxyUrl);
    }
}

function sanitizeProxyUrl(value: string): string {
    try {
        const url = new URL(value);

        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return '<invalid proxy URL>';
    }
}

function defaultAgentCreator(uri: string, clientFactory: PoolClientFactory): ProxyAgent {
    return new ProxyAgent({
        uri,
        clientFactory: clientFactory as (origin: URL, opts: object) => Dispatcher,
    });
}

interface PoolFactoryOptions {
    connections?: number;
    connect?: {
        timeout?: number;
        [key: string]: unknown;
    };

    [key: string]: unknown;
}

const createPoolFactory =
    (poolConfig: ProxyPoolConfig) =>
    (url: string | URL, opts: PoolFactoryOptions = {}): Pool => {
        const { connections, connect = {}, ...rest } = opts;

        return new Pool(url, {
            ...rest,
            connections: connections ?? poolConfig.connections,
            pipelining: poolConfig.pipelining,
            keepAliveTimeout: poolConfig.keepAliveTimeout,
            headersTimeout: poolConfig.headersTimeout,
            bodyTimeout: poolConfig.bodyTimeout,
            connect: {
                timeout: connect.timeout ?? poolConfig.connectTimeout,
                ...connect,
            },
        });
    };

