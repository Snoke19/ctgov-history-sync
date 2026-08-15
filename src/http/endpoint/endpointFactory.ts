import { createLogger } from '../../config/logging.js';
import { EndpointAssemblyError, TrialError } from '../../error/errors.js';
import { LimiterFactory } from '../limiter/factory/limiterFactory.js';
import type { Limiter } from '../limiter/limiter.js';
import type { HttpTransport } from '../transport/httpTransport.js';
import { Endpoint } from './endpoint.js';
import type { EndpointDefinition, EndpointProvider } from './provider/endpointProvider.js';

const logger = createLogger(import.meta.url);

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

    async build(): Promise<Endpoint[]> {
        logger.info('Starting endpoint assembly');

        try {
            const createLimiter = (): Limiter => this.limiterFactory.create();
            const definitions = this.provider.build();

            const endpoints = await assembleEndpoints({
                definitions,
                createLimiter,
                createEndpoint: defaultEndpointCtor,
            });

            logger.info({ endpointCount: endpoints.length }, 'Endpoints assembled');

            return endpoints;
        } catch (error: unknown) {
            const trialError = TrialError.normalize(error);

            logger.error({ err: trialError, errorType: trialError.name }, 'Endpoint assembly failed');

            throw trialError;
        }
    }
}

async function assembleEndpoints(param: EndpointAssemblyOptions): Promise<Endpoint[]> {
    const { definitions, createLimiter, createEndpoint } = param;
    const endpoints: Endpoint[] = [];

    try {
        for (const definition of definitions) {
            const endpoint = await constructEndpoint(definition, createLimiter, createEndpoint);
            endpoints.push(endpoint);

            logger.debug({ endpointId: definition.id }, 'Endpoint constructed');
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
    let transport: HttpTransport | undefined;

    try {
        transport = definition.createTransport();

        return createEndpoint(definition.id, createLimiter(), transport);
    } catch (error: unknown) {
        logger.error(
            { endpointId: definition.id, err: error, errorType: describeErrorType(error) },
            'Endpoint construction failed',
        );

        if (transport !== undefined) {
            await closeFailedEndpointTransport({
                transport,
                endpointId: definition.id,
                constructionError: error,
            });
        }

        throw error;
    }
}

function describeErrorType(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

async function closeFailedEndpointTransport(param: FailedEndpointCleanup): Promise<never> {
    try {
        await param.transport.close();
    } catch (cleanupError) {
        throw new EndpointAssemblyError(
            `Failed to construct endpoint "${param.endpointId}" and transport cleanup also failed.`,
            {
                cause: param.constructionError,
                context: {
                    endpointId: param.endpointId,
                },
            },
            [cleanupError],
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

    logger.error(
        {
            endpointCount: endpoints.length,
            cleanupErrorCount: cleanupErrors.length,
            err: cleanupErrors[0],
        },
        'Endpoint rollback cleanup failed',
    );

    throw new EndpointAssemblyError(
        'Endpoint assembly failed and rollback cleanup also failed.',
        {
            cause: assemblyError,
        },
        cleanupErrors,
    );
}
