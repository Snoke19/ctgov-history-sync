import { describe, expect, it, jest } from '@jest/globals';
import { createApiClientWithHttpClient, type ApiHttpClient } from '../../../src/api/api.js';
import { ApiResponseValidationError, TrialNotFoundError, TrialValidationError } from '../../../src/error/errors.js';

const TEST_BASE_URL: string = 'https://api.test.gov/api/v2/studies';
const TEST_DETAIL_URL: string = 'https://api.test.gov/api/v2/studies/detail';

describe('ApiClient', () => {
    type FetchJsonMock = jest.MockedFunction<ApiHttpClient['fetchJson']>;
    type CloseMock = jest.MockedFunction<ApiHttpClient['close']>;

    interface HttpClientMock {
        fetchJson: FetchJsonMock;
        close: CloseMock;
    }

    function createHttpClientMock(returnValue: unknown = { studies: [] }): HttpClientMock {
        return {
            fetchJson: jest.fn<ApiHttpClient['fetchJson']>().mockResolvedValue(returnValue),

            close: jest.fn<ApiHttpClient['close']>().mockResolvedValue(undefined),
        };
    }

    function makeApi(httpClient: HttpClientMock) {
        return createApiClientWithHttpClient(httpClient);
    }

    it('rejects a null studies response', async () => {
        const httpClient = createHttpClientMock(null);
        const api = makeApi(httpClient);

        await expect(api.fetchStudiesPage()).rejects.toBeInstanceOf(ApiResponseValidationError);
    });

    it('rejects a studies response without a studies array', async () => {
        const httpClient = createHttpClientMock({ studies: {} });
        const api = makeApi(httpClient);

        await expect(api.fetchStudiesPage()).rejects.toBeInstanceOf(ApiResponseValidationError);
    });

    it('rejects an invalid nextPageToken', async () => {
        const httpClient = createHttpClientMock({
            studies: [],
            nextPageToken: 123,
        });

        const api = makeApi(httpClient);

        await expect(api.fetchStudiesPage()).rejects.toBeInstanceOf(ApiResponseValidationError);
    });

    it('rejects an invalid study entry', async () => {
        const httpClient = createHttpClientMock({
            studies: [null],
        });

        const api = makeApi(httpClient);

        await expect(api.fetchStudiesPage()).rejects.toBeInstanceOf(ApiResponseValidationError);
    });

    it('includes the endpoint URL in response validation errors', async () => {
        const httpClient = createHttpClientMock({ studies: {} });
        const api = makeApi(httpClient);

        await expect(api.fetchStudiesPage()).rejects.toMatchObject({
            url: TEST_BASE_URL,
        });
    });

    it('accepts a valid studies response', async () => {
        const data = {
            studies: [
                {
                    protocolSection: {
                        identificationModule: {
                            nctId: 'NCT12345678',
                        },
                    },
                },
            ],
            nextPageToken: 'next-token',
        };

        const httpClient = createHttpClientMock(data);
        const api = makeApi(httpClient);

        await expect(api.fetchStudiesPage()).resolves.toEqual(data);
    });

    it('normalizes the NCT ID before constructing the detail URL', async () => {
        const httpClient = createHttpClientMock({ protocolSection: {} });

        const client = createApiClientWithHttpClient(httpClient);

        await client.fetchTrialDetail(' nct12345678 ');

        expect(httpClient.fetchJson).toHaveBeenCalledWith(`${TEST_DETAIL_URL}/NCT12345678`, {
            allow404: true,
        });
    });

    describe('fetchStudiesPage', () => {
        it('builds a URL from page params and returns the parsed response', async () => {
            const data = {
                studies: [{ protocolSection: {} }],
                nextPageToken: 'token-2',
            };

            const httpClient = createHttpClientMock(data);
            const api = makeApi(httpClient);

            const result = await api.fetchStudiesPage({
                pageSize: 100,
                pageToken: 'token-1',
                countTotal: true,
                'query.term': 'cancer',
            });

            expect(httpClient.fetchJson).toHaveBeenCalledTimes(1);
            expect(httpClient.fetchJson).toHaveBeenCalledWith(
                `${TEST_BASE_URL}?pageSize=100&pageToken=token-1&countTotal=true&query.term=cancer`,
            );
            expect(result).toEqual(data);
        });

        it('hits the bare base URL when no params are supplied', async () => {
            const httpClient = createHttpClientMock({ studies: [] });
            const api = makeApi(httpClient);

            await api.fetchStudiesPage();

            expect(httpClient.fetchJson).toHaveBeenCalledWith(TEST_BASE_URL);
        });
    });

    describe('fetchTrialDetail', () => {
        it('normalizes a valid NCT ID before making the request', async () => {
            const httpClient = createHttpClientMock({ protocolSection: {} });
            const api = makeApi(httpClient);

            await api.fetchTrialDetail(' nct12345678 ');

            expect(httpClient.fetchJson).toHaveBeenCalledWith(`${TEST_DETAIL_URL}/NCT12345678`, {
                allow404: true,
            });
        });

        it.each(['', '   ', '12345678', 'XYZ12345678', 'NCT1234567', 'NCT123456789'])(
            'rejects invalid NCT ID "%s" without making a request',
            async (nctId) => {
                const httpClient = createHttpClientMock();
                const api = makeApi(httpClient);

                await expect(api.fetchTrialDetail(nctId)).rejects.toBeInstanceOf(TrialValidationError);

                expect(httpClient.fetchJson).not.toHaveBeenCalled();
            },
        );

        it('accepts NCT IDs case-insensitively', async () => {
            const httpClient = createHttpClientMock({ protocolSection: {} });
            const api = makeApi(httpClient);

            await api.fetchTrialDetail('nct12345678');

            expect(httpClient.fetchJson).toHaveBeenCalledWith(`${TEST_DETAIL_URL}/NCT12345678`, {
                allow404: true,
            });
        });

        it('builds a URL with the NCT path segment and detail params', async () => {
            const data = { nctId: 'NCT00000001' };
            const httpClient = createHttpClientMock(data);
            const api = makeApi(httpClient);

            const result = await api.fetchTrialDetail('NCT00000001', {
                history: true,
            });

            expect(httpClient.fetchJson).toHaveBeenCalledTimes(1);
            expect(httpClient.fetchJson).toHaveBeenCalledWith(`${TEST_DETAIL_URL}/NCT00000001?history=true`, {
                allow404: true,
            });
            expect(result).toEqual(data);
        });

        it('requests allow404 so a missing trial surfaces as null', async () => {
            const httpClient = createHttpClientMock({
                nctId: 'NCT00000001',
            });

            const api = makeApi(httpClient);

            await api.fetchTrialDetail('NCT00000001');

            expect(httpClient.fetchJson).toHaveBeenCalledWith(`${TEST_DETAIL_URL}/NCT00000001`, {
                allow404: true,
            });
        });

        it('throws TrialNotFoundError when the detail response is null', async () => {
            const httpClient = createHttpClientMock(null);
            const api = makeApi(httpClient);

            await expect(api.fetchTrialDetail('NCT00000001')).rejects.toBeInstanceOf(TrialNotFoundError);
        });

        it('rejects invalid NCT IDs before performing any request', async () => {
            const httpClient = createHttpClientMock({
                nctId: 'NCT00000001',
            });

            const api = makeApi(httpClient);

            await expect(api.fetchTrialDetail('123')).rejects.toBeInstanceOf(TrialValidationError);

            await expect(api.fetchTrialDetail('')).rejects.toBeInstanceOf(TrialValidationError);

            expect(httpClient.fetchJson).not.toHaveBeenCalled();
        });
    });

    describe('close', () => {
        it('closes the underlying HTTP client', async () => {
            const httpClient = createHttpClientMock();
            const api = makeApi(httpClient);

            await api.close();

            expect(httpClient.close).toHaveBeenCalledTimes(1);
        });
    });
});
