import { describe, expect, it, jest } from '@jest/globals';
import { createApiClient, FetchJsonOptions } from '../../../src/api/api.js';
import { API_BASE_URL, API_DETAIL_URL } from '../../../src/config/config.js';
import { TrialNotFoundError, TrialValidationError } from '../../../src/error/errors.js';

describe('ApiClient', () => {
    function createFetchJsonMock(returnValue: unknown = { studies: [] }) {
        return jest.fn<(url: string, options?: FetchJsonOptions) => Promise<unknown>>().mockResolvedValue(returnValue);
    }

    describe('fetchStudiesPage', () => {
        it('builds a URL from page params and returns the parsed response', async () => {
            const data = { studies: [{ protocolSection: {} }], nextPageToken: 'token-2' };
            const fetchJson = createFetchJsonMock(data);
            const api = createApiClient({ fetchJson });

            const result = await api.fetchStudiesPage({
                pageSize: 100,
                pageToken: 'token-1',
                countTotal: true,
                'query.term': 'cancer',
            });

            expect(fetchJson).toHaveBeenCalledTimes(1);
            expect(fetchJson).toHaveBeenCalledWith(
                `${API_BASE_URL}?pageSize=100&pageToken=token-1&countTotal=true&query.term=cancer`,
            );
            expect(result).toEqual(data);
        });

        it('hits the bare base URL when no params are supplied', async () => {
            const fetchJson = createFetchJsonMock({ studies: [] });
            const api = createApiClient({ fetchJson });

            await api.fetchStudiesPage();

            expect(fetchJson).toHaveBeenCalledWith(API_BASE_URL);
        });
    });

    describe('fetchTrialDetail', () => {
        it('builds a URL with the NCT path segment and detail params', async () => {
            const data = { nctId: 'NCT00000001' };
            const fetchJson = createFetchJsonMock(data);
            const api = createApiClient({ fetchJson });

            const result = await api.fetchTrialDetail('NCT00000001', { history: true });

            expect(fetchJson).toHaveBeenCalledTimes(1);
            expect(fetchJson).toHaveBeenCalledWith(`${API_DETAIL_URL}/NCT00000001?history=true`, { allow404: true });
            expect(result).toEqual(data);
        });

        it('requests allow404 so a missing trial surfaces as null', async () => {
            const fetchJson = createFetchJsonMock({ nctId: 'NCT00000001' });
            const api = createApiClient({ fetchJson });

            await api.fetchTrialDetail('NCT00000001');

            expect(fetchJson).toHaveBeenCalledWith(`${API_DETAIL_URL}/NCT00000001`, { allow404: true });
        });

        it('throws TrialNotFoundError when the detail response is null', async () => {
            const fetchJson = createFetchJsonMock(null);
            const api = createApiClient({ fetchJson });

            await expect(api.fetchTrialDetail('NCT00000001')).rejects.toBeInstanceOf(TrialNotFoundError);
        });

        it('rejects invalid NCT IDs before performing any request', async () => {
            const fetchJson = createFetchJsonMock({ nctId: 'NCT00000001' });
            const api = createApiClient({ fetchJson });

            await expect(api.fetchTrialDetail('123')).rejects.toBeInstanceOf(TrialValidationError);
            await expect(api.fetchTrialDetail('')).rejects.toBeInstanceOf(TrialValidationError);
            expect(fetchJson).not.toHaveBeenCalled();
        });
    });
});
