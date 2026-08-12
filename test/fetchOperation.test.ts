import { describe, expect, it } from '@jest/globals';
import { FetchOperation } from '../src/http/retry/fetchOperation.js';
import { EndpointAcquisitionTimeoutError, TimeoutException } from '../src/error/errors.js';

class StubEndpointManager {
    constructor(private readonly toThrow?: Error) {}
    async acquireEndpoint(_remainingMs: number, _signal: AbortSignal) {
        if (this.toThrow) throw this.toThrow;
        return { url: 'x', transport: { request: async () => { throw new Error('not used'); } } } as any;
    }
}

describe('FetchOperation', () => {
    it('maps EndpointAcquisitionTimeoutError to TimeoutException', async () => {
        const now = () => Date.now();
        const manager = new StubEndpointManager(new EndpointAcquisitionTimeoutError(1000, 2));
        const op = new FetchOperation(manager as any, 'https://x', {}, now);
        await expect(op.perform()).rejects.toThrow(TimeoutException);
    });
});
