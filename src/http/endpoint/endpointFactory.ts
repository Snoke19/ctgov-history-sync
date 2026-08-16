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
        try {
            const createLimiter = (): Limiter => this.limiterFactory.create();
            const definitions = this.provider.build();

            return await assembleEndpoints({
                definitions,
                createLimiter,
                createEndpoint: defaultEndpointCtor,
            });
        } catch (error: unknown) {
            // Lower layer: the exception is preserved and rethrown; the
            // composition root (createApiClient) and the application boundary
            // (src/index.ts) report the final failure.
            throw TrialError.normalize(error);
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

            logger.debug({ endpoint: sanitizeEndpointUrl(definition.id) }, 'Endpoint constructed');
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
        // Low-level diagnostic only; the composition root reports the final
        // failure. The sanitized endpoint id keeps proxy topology diagnosable.
        logger.debug(
            { endpoint: sanitizeEndpointUrl(definition.id), err: error, errorType: describeErrorType(error) },
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
            `Failed to construct endpoint "${sanitizeEndpointUrl(param.endpointId)}" and transport cleanup also failed.`,
            {
                cause: param.constructionError,
                context: {
                    endpointId: sanitizeEndpointUrl(param.endpointId),
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

function sanitizeEndpointUrl(value: string): string {
    try {
        const url = new URL(value);

        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return '<invalid endpoint URL>';
    }
}
