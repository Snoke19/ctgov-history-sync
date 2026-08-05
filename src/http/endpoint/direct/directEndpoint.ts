import type { Limiter } from '../../limiter/limiter.js';
import { Endpoint } from '../endpoint.js';
import { FetchTransport } from '../transport/fetchTransport.js';
import type { DirectEndpointHandle } from '../types/endpoints.js';

export const DIRECT_ENDPOINT_URL = 'direct' as const;

export class DirectEndpoint extends Endpoint {
    private readonly handle: DirectEndpointHandle;

    constructor(limiter: Limiter) {
        if (!limiter) throw new TypeError('DirectEndpoint requires a limiter');

        super(DIRECT_ENDPOINT_URL, limiter);
        this.handle = Object.freeze({
            url: this.getUrl(),
            transport: new FetchTransport(),
        });
    }

    getHandle(): DirectEndpointHandle {
        return this.handle;
    }

    async close(): Promise<void> {
        return this.handle.transport.close();
    }
}
