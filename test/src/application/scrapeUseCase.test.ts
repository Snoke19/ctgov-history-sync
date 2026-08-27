import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ApiClient } from '../../../src/api/api.js';
import { ScrapeUseCase } from '../../../src/application/scrapeUseCase.js';
import { TrialNotFoundError } from '../../../src/error/errors.js';

function createStudy(nctId: string) {
    return {
        protocolSection: {
            identificationModule: { nctId },
        },
    };
}

function createMockApi(overrides: Partial<ApiClient> = {}): jest.Mocked<ApiClient> {
    return {
        fetchStudiesPage: jest.fn() as unknown as jest.MockedFunction<ApiClient['fetchStudiesPage']>,
        fetchTrialDetail: jest.fn() as unknown as jest.MockedFunction<ApiClient['fetchTrialDetail']>,
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as jest.Mocked<ApiClient>;
}

describe('ScrapeUseCase', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    it('can be instantiated without starting the process', () => {
        const api = createMockApi();
        const useCase = new ScrapeUseCase(api, { pageSize: 10, concurrency: 2, dateRange: 'test' });
        expect(useCase).toBeInstanceOf(ScrapeUseCase);
    });

    it('paginates through all pages and fetches trial details with concurrency', async () => {
        const api = createMockApi();
        api.fetchStudiesPage
            .mockResolvedValueOnce({
                studies: [createStudy('NCT00000001'), createStudy('NCT00000002')],
                nextPageToken: 'token-1',
            } as unknown as never)
            .mockResolvedValueOnce({
                studies: [createStudy('NCT00000003')],
                nextPageToken: undefined,
            } as unknown as never);

        api.fetchTrialDetail.mockImplementation(async (nctId: string) => ({ nctId }));

        const useCase = new ScrapeUseCase(api, { pageSize: 2, concurrency: 2, dateRange: 'test-range' });

        await useCase.execute();

        expect(api.fetchStudiesPage).toHaveBeenCalledTimes(2);
        expect(api.fetchStudiesPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageSize: 2, 'query.term': 'test-range' }));
        expect(api.fetchTrialDetail).toHaveBeenCalledTimes(3);
        expect(api.fetchTrialDetail).toHaveBeenCalledWith('NCT00000001', { history: true });
    });

    it('handles per-item failures without failing the whole scrape', async () => {
        const api = createMockApi();
        api.fetchStudiesPage.mockResolvedValue({
            studies: [createStudy('NCT00000001'), createStudy('NCT00000002')],
            nextPageToken: undefined,
        } as unknown as never);
        api.fetchTrialDetail
            .mockRejectedValueOnce(new TrialNotFoundError('NCT00000001'))
            .mockResolvedValueOnce({ ok: true });

        const useCase = new ScrapeUseCase(api, { pageSize: 10, concurrency: 2, dateRange: 'x' });

        await expect(useCase.execute()).resolves.toBeUndefined();
        expect(api.fetchTrialDetail).toHaveBeenCalledTimes(2);
    });

    it('uses the next page token to fetch the following page', async () => {
        const api = createMockApi();
        api.fetchStudiesPage
            .mockResolvedValueOnce({
                studies: [createStudy('NCT00000001')],
                nextPageToken: 't1',
            } as unknown as never)
            .mockResolvedValueOnce({
                studies: [],
                nextPageToken: undefined,
            } as unknown as never);
        api.fetchTrialDetail.mockResolvedValue({});

        const useCase = new ScrapeUseCase(api, { pageSize: 1, concurrency: 1, dateRange: 'x' });
        await useCase.execute();

        expect(api.fetchStudiesPage).toHaveBeenCalledWith(expect.objectContaining({ pageToken: 't1' }));
    });
});
