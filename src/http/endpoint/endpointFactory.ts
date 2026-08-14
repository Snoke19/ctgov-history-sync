import { LimiterFactory } from '../limiter/factory/limiterFactory.js';
import type { Limiter } from '../limiter/limiter.js';
import type { HttpTransport } from '../transport/httpTransport.js';
import type { HttpClientOptions } from '../types/http.js';
import { Endpoint } from './endpoint.js';
import type { EndpointDefinition, EndpointProvider } from './provider/endpointProvider.js';

const defaultEndpointCtor: EndpointCtor = (id, limiter, transport) => new Endpoint(id, limiter, transport);

type EndpointCtor = (id: string, limiter: Limiter, transport: HttpTransport) => Endpoint;

type EndpointAssemblyOptions = {
    readonly definitions: readonly EndpointDefinition[];
    readonly createLimiter: () => Limiter;
    readonly createEndpoint: EndpointCtor;
};

type FailedEndpointCleanup = {
    readonly transport: HttpTransport;
    readonly endpointId: string;
    readonly constructionError: unknown;
};

export class EndpointFactory {
    constructor(
        private readonly provider: EndpointProvider,
        private readonly limiterFactory: LimiterFactory,
    ) {}

    async build(options: HttpClientOptions): Promise<Endpoint[]> {
        const createLimiter = (): Limiter => this.limiterFactory.create(options);

        return assembleEndpoints({
            definitions: this.provider.build(options),
            createLimiter,
            createEndpoint: defaultEndpointCtor,
        });
    }
}

async function assembleEndpoints(param: EndpointAssemblyOptions): Promise<Endpoint[]> {
    const { definitions, createLimiter, createEndpoint } = param;
    const endpoints: Endpoint[] = [];

    try {
        for (const definition of definitions) {
            const endpoint = await constructEndpoint(definition, createLimiter, createEndpoint);
            endpoints.push(endpoint);
        }

        return endpoints;
    } catch (error) {
        await rollbackEndpoints(endpoints, error);
        throw error;
    }
}

async function constructEndpoint(
    definition: EndpointDefinition,
    createLimiter: () => Limiter,
    createEndpoint: EndpointCtor = defaultEndpointCtor,
): Promise<Endpoint> {
    const transport = definition.createTransport();

    try {
        return createEndpoint(definition.id, createLimiter(), transport);
    } catch (error) {
        await closeFailedEndpointTransport({
            transport,
            endpointId: definition.id,
            constructionError: error,
        });

        throw error;
    }
}

async function closeFailedEndpointTransport(param: FailedEndpointCleanup): Promise<never> {
    try {
        await param.transport.close();
    } catch (cleanupError) {
        throw new AggregateError(
            [param.constructionError, cleanupError],
            `Failed to construct endpoint "${param.endpointId}" and transport cleanup also failed.`,
            { cause: param.constructionError },
        );
    }

    throw param.constructionError;
}

async function rollbackEndpoints(endpoints: readonly Endpoint[], assemblyError: unknown): Promise<void> {
    const cleanupResults = await Promise.allSettled(endpoints.map((endpoint) => endpoint.close()));

    const cleanupErrors = cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);

    if (cleanupErrors.length === 0) {
        return;
    }

    throw new AggregateError(
        [assemblyError, ...cleanupErrors],
        'Endpoint assembly failed and rollback cleanup also failed.',
        { cause: assemblyError },
    );
}
