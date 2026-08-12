import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// The API client reads configuration from environment variables via
// src/config/config.ts. Tests ensure stable defaults by setting the env
// variables before importing the modules that read them.

beforeEach(() => {
    // Ensure module cache is cleared so config reads our test env values.
    jest.resetModules();
    process.env.API_BASE_URL = 'https://api.test';
    process.env.API_DETAIL_URL = 'https://api.test/details';
});

describe('ApiClient', () => {
    function createFetchJsonMock(returnValue: unknown = { studies: [] }) {
        return jest.fn<(url: string, options?: any) => Promise<unknown>>().mockResolvedValue(returnValue);
    }

    describe('fetchStudiesPage', () => {
        it('builds a URL from page params and returns the parsed response', async () => {
            const { createApiClient } = await import('../../../src/api/api.js');

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
                `https://api.test?pageSize=100&pageToken=token-1&countTotal=true&query.term=cancer`,
            );
            expect(result).toEqual(data);
        });

        it('hits the bare base URL when no params are supplied', async () => {
            const { createApiClient } = await import('../../../src/api/api.js');

            const fetchJson = createFetchJsonMock({ studies: [] });
            const api = createApiClient({ fetchJson });

            await api.fetchStudiesPage();

            expect(fetchJson).toHaveBeenCalledWith('https://api.test');
        });
    });

    describe('fetchTrialDetail', () => {
        it('builds a URL with the NCT path segment and detail params', async () => {
            const { createApiClient } = await import('../../../src/api/api.js');

            const data = { nctId: 'NCT00000001' };
            const fetchJson = createFetchJsonMock(data);
            const api = createApiClient({ fetchJson });

            const result = await api.fetchTrialDetail('NCT00000001', { history: true });

            expect(fetchJson).toHaveBeenCalledTimes(1);
            expect(fetchJson).toHaveBeenCalledWith('https://api.test/details/NCT00000001?history=true', { allow404: true });
            expect(result).toEqual(data);
        });

        it('requests allow404 so a missing trial surfaces as null', async () => {
            const { createApiClient } = await import('../../../src/api/api.js');

            const fetchJson = createFetchJsonMock({ nctId: 'NCT00000001' });
            const api = createApiClient({ fetchJson });

            await api.fetchTrialDetail('NCT00000001');

            expect(fetchJson).toHaveBeenCalledWith('https://api.test/details/NCT00000001', { allow404: true });
        });

        it('throws TrialNotFoundError when the detail response is null', async () => {
            const { createApiClient } = await import('../../../src/api/api.js');
            const errors = await import('../../../src/error/errors.js');

            const fetchJson = createFetchJsonMock(null);
            const api = createApiClient({ fetchJson });

            await expect(api.fetchTrialDetail('NCT00000001')).rejects.toBeInstanceOf(errors.TrialNotFoundError);
        });

        it('rejects invalid NCT IDs before performing any request', async () => {
            const { createApiClient } = await import('../../../src/api/api.js');
            const errors = await import('../../../src/error/errors.js');

            const fetchJson = createFetchJsonMock({ nctId: 'NCT00000001' });
            const api = createApiClient({ fetchJson });

            await expect(api.fetchTrialDetail('123')).rejects.toBeInstanceOf(errors.TrialValidationError);
            await expect(api.fetchTrialDetail('')).rejects.toBeInstanceOf(errors.TrialValidationError);
            expect(fetchJson).not.toHaveBeenCalled();
        });
    });
});
