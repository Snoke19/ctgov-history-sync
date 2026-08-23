import { jest } from '@jest/globals';
import type { Dispatcher } from 'undici';
import { ProxyAgent } from 'undici';
import type { HttpTransport } from '../../../src/http/transport/httpTransport.js';
import {
    UndiciTransportFactory,
    type AgentCreatorFn,
    type PoolClientFactory,
    type PoolCreatorFn,
} from '../../../src/http/transport/impl/undiciProxyTransport.js';

export function createMockTransport(
    close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
): jest.Mocked<HttpTransport> {
    return {
        request: jest.fn(),
        classifyError: jest.fn(),
        close,
    };
}

export function createUndiciTransportFactory(): UndiciTransportFactory {
    const poolClientFactory = jest.fn<PoolClientFactory>().mockReturnValue({} as Dispatcher);

    const poolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(poolClientFactory);

    const agent = {
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as ProxyAgent;

    const agentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(agent);

    return new UndiciTransportFactory({
        poolConfig: {
            connections: 10,
            maxConnections: 100,
            pipelining: 1,
            keepAliveTimeout: 4000,
            headersTimeout: 30000,
            bodyTimeout: 30000,
            connectTimeout: 10000,
        },
        poolCreator,
        agentCreator,
    });
}
