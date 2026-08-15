import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { UnexpectedError } from '../../../../src/error/errors.js';
import { EndpointFactory } from '../../../../src/http/endpoint/endpointFactory.js';
import type { EndpointDefinition, EndpointProvider } from '../../../../src/http/endpoint/provider/endpointProvider.js';
import type { LimiterFactory } from '../../../../src/http/limiter/factory/limiterFactory.js';
import type { Limiter } from '../../../../src/http/limiter/limiter.js';
import type { HttpTransport } from '../../../../src/http/transport/httpTransport.js';

describe('EndpointFactory', () => {
    const createTransport: jest.MockedFunction<EndpointDefinition['createTransport']> = jest.fn();
    const providerBuild: jest.MockedFunction<EndpointProvider['build']> = jest.fn();
    const limiterFactoryCreate: jest.MockedFunction<LimiterFactory['create']> = jest.fn();

    const transport: jest.Mocked<HttpTransport> = {
        request: jest.fn(),
        classifyError: jest.fn(),
        close: jest.fn(),
    };

    const limiter = {} as Limiter;

    const definition: EndpointDefinition = {
        id: 'test-endpoint',
        createTransport,
    };

    const provider: EndpointProvider = {
        build: providerBuild,
    };

    const limiterFactory: LimiterFactory = {
        create: limiterFactoryCreate,
    };

    let factory: EndpointFactory;

    beforeEach(() => {
        jest.clearAllMocks();

        createTransport.mockReturnValue(transport);
        providerBuild.mockReturnValue([definition]);
        limiterFactoryCreate.mockReturnValue(limiter);

        factory = new EndpointFactory(provider, limiterFactory);
    });

    describe('build', () => {
        it('normalizes a transport creation error', async () => {
            const constructionError = new Error('transport creation failed');

            createTransport.mockImplementation(() => {
                throw constructionError;
            });

            await expect(factory.build()).rejects.toMatchObject({
                name: 'UnexpectedError',
                cause: constructionError,
            });

            expect(providerBuild).toHaveBeenCalledTimes(1);
            expect(createTransport).toHaveBeenCalledTimes(1);
            expect(limiterFactoryCreate).not.toHaveBeenCalled();
            expect(transport.close).not.toHaveBeenCalled();
        });

        it('closes the transport and normalizes limiter creation errors', async () => {
            const constructionError = new Error('limiter creation failed');

            limiterFactoryCreate.mockImplementation(() => {
                throw constructionError;
            });

            await expect(factory.build()).rejects.toMatchObject({
                name: 'UnexpectedError',
                cause: constructionError,
            });

            expect(providerBuild).toHaveBeenCalledTimes(1);
            expect(createTransport).toHaveBeenCalledTimes(1);
            expect(limiterFactoryCreate).toHaveBeenCalledTimes(1);
            expect(transport.close).toHaveBeenCalledTimes(1);
        });

        it('normalizes provider build errors to UnexpectedError', async () => {
            const providerError = new Error('provider build failed');

            providerBuild.mockImplementation(() => {
                throw providerError;
            });

            await expect(factory.build()).rejects.toBeInstanceOf(UnexpectedError);

            expect(providerBuild).toHaveBeenCalledTimes(1);
            expect(limiterFactoryCreate).not.toHaveBeenCalled();
            expect(createTransport).not.toHaveBeenCalled();
        });

        it('builds an endpoint successfully', async () => {
            const endpoints = await factory.build();

            expect(endpoints).toHaveLength(1);
            expect(providerBuild).toHaveBeenCalledTimes(1);
            expect(createTransport).toHaveBeenCalledTimes(1);
            expect(limiterFactoryCreate).toHaveBeenCalledTimes(1);
            expect(transport.close).not.toHaveBeenCalled();
        });

        it('returns EndpointAssemblyError when transport cleanup fails during endpoint construction', async () => {
            const constructionError = new Error('limiter creation failed');
            const cleanupError = new Error('transport cleanup failed');

            limiterFactoryCreate.mockImplementation(() => {
                throw constructionError;
            });

            transport.close.mockRejectedValue(cleanupError);

            await expect(factory.build()).rejects.toEqual(
                expect.objectContaining({
                    name: 'EndpointAssemblyError',
                    message: 'Failed to construct endpoint "test-endpoint" and transport cleanup also failed.',
                    cause: constructionError,
                    cleanupErrors: [cleanupError],
                    context: {
                        endpointId: 'test-endpoint',
                    },
                }),
            );

            expect(transport.close).toHaveBeenCalledTimes(1);
        });

        it('returns EndpointAssemblyError when endpoint rollback cleanup fails', async () => {
            const assemblyError = new Error('second endpoint construction failed');
            const rollbackError = new Error('first endpoint cleanup failed');

            const secondTransport: jest.Mocked<HttpTransport> = {
                request: jest.fn(),
                classifyError: jest.fn(),
                close: jest.fn(),
            };

            secondTransport.close.mockResolvedValue(undefined);

            providerBuild.mockReturnValue([
                definition,
                {
                    id: 'second-endpoint',
                    createTransport: () => secondTransport,
                },
            ]);

            limiterFactoryCreate.mockReturnValueOnce(limiter).mockImplementationOnce(() => {
                throw assemblyError;
            });

            transport.close.mockRejectedValue(rollbackError);

            await expect(factory.build()).rejects.toEqual(
                expect.objectContaining({
                    name: 'EndpointAssemblyError',
                    message: 'Endpoint assembly failed and rollback cleanup also failed.',
                    cause: assemblyError,
                    cleanupErrors: [rollbackError],
                }),
            );

            expect(transport.close).toHaveBeenCalledTimes(1);
            expect(secondTransport.close).toHaveBeenCalledTimes(1);
        });
    });
});
