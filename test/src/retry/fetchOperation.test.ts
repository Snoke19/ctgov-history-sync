import { describe, expect, it, jest } from '@jest/globals';
import { CallerAbortedError, EndpointAcquisitionTimeoutError } from '../../../src/error/errors.js';
import type { EndpointManager } from '../../../src/http/endpoint/manager/endpointManager.js';
import { FetchOperation } from '../../../src/retry/fetchOperation.js';

describe('FetchOperation', () => {
    it('prioritizes caller cancellation over endpoint acquisition timeout', async () => {
        const controller = new AbortController();

        const endpointManager = {
            acquireEndpoint: jest.fn().mockImplementation(async () => {
                controller.abort();

                throw new EndpointAcquisitionTimeoutError(1000, 1);
            }),
        } as unknown as EndpointManager;

        const operation = new FetchOperation(
            endpointManager,
            'https://example.com',
            {
                signal: controller.signal,
                timeoutMs: 1000,
            },
            { timeoutMs: 1000, userAgent: 'TestAgent/1.0' },
        );

        await expect(operation.perform()).rejects.toBeInstanceOf(CallerAbortedError);
    });
});
