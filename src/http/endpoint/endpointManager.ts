import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from '../../config/logging.js';
import { ConfigurationError, EndpointAcquisitionTimeoutError } from '../../error/errors.js';
import { Endpoint } from './endpoint.js';
import type { AcquiredEndpointHandle } from './types/endpoints.js';

const now = (): number => performance.now();

export class EndpointManager {
    private readonly endpoints: readonly Endpoint[];
    private readonly acquireTimeout: number;
    private nextIndex = 0;

    constructor(endpoints: readonly Endpoint[], acquireTimeout: number) {
        if (endpoints.length === 0) {
            throw new ConfigurationError('EndpointManager requires at least one endpoint.');
        }

        this.endpoints = endpoints;
        this.acquireTimeout = acquireTimeout;

        logger.info('Endpoint manager initialized | Endpoints: %d', this.endpoints.length);
    }

    get endpointCount(): number {
        return this.endpoints.length;
    }

    async acquireEndpoint(
        timeoutMs = this.acquireTimeout,
        signal?: AbortSignal,
    ): Promise<AcquiredEndpointHandle> {
        const deadline = now() + timeoutMs;

        while (true) {
            // Single clock read per iteration to avoid skew between the
            // endpoint scan and the deadline check.
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }

            const currentTime = now();
            const remaining = deadline - currentTime;

            if (remaining <= 0) {
                throw new EndpointAcquisitionTimeoutError(timeoutMs, this.endpoints.length);
            }

            let shortestWait = Infinity;

            for (let i = 0; i < this.endpoints.length; i++) {
                const index = (this.nextIndex + i) % this.endpoints.length;
                const endpoint = this.endpoints[index];

                if (!endpoint) {
                    continue;
                }

                if (endpoint.tryAcquire(currentTime)) {
                    this.nextIndex = (index + 1) % this.endpoints.length;
                    return endpoint.getHandle();
                }

                shortestWait = Math.min(shortestWait, endpoint.timeUntilToken(currentTime));
            }

            await sleep(Math.min(shortestWait, remaining), undefined, { signal });
        }
    }

    async close(): Promise<void> {
        await Promise.all(this.endpoints.map((ep) => ep.close()));
        logger.info('Endpoint manager closed | Endpoints released: %d', this.endpoints.length);
    }
}
