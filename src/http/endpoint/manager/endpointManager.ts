import { logger } from '../../../config/logging.js';
import { CallerAbortedError, ConfigurationError, EndpointAcquisitionTimeoutError } from '../../../error/errors.js';
import { assertPositiveInt } from '../../../utils/validation.js';
import { defaultMonotonicClock, defaultSleeper } from '../../types/clock.js';
import type { MonotonicClock, Sleeper } from '../../types/clock.js';
import { Endpoint, EndpointHandle } from '../endpoint.js';

export class EndpointManager {
    private readonly endpoints: readonly Endpoint[];
    private readonly acquireTimeout: number;
    private readonly clock: MonotonicClock['now'];
    private readonly sleep: Sleeper['sleep'];
    private nextIndex = 0;

    /**
     * @param endpoints       Pre-built endpoint list (at least one required).
     * @param acquireTimeout  Maximum time in ms to wait for an endpoint.
     * @param clock           Monotonic clock used for acquisition timing.
     * @param sleep           Abort-aware delay used while waiting for availability.
     */
    constructor(
        endpoints: readonly Endpoint[],
        acquireTimeout: number,
        clock: MonotonicClock['now'] = defaultMonotonicClock.now,
        sleep: Sleeper['sleep'] = defaultSleeper.sleep,
    ) {
        if (endpoints.length === 0) {
            throw new ConfigurationError('EndpointManager requires at least one endpoint.');
        }
        assertPositiveInt(acquireTimeout, 'acquireTimeout');

        this.endpoints = endpoints;
        this.acquireTimeout = acquireTimeout;
        this.clock = clock;
        this.sleep = sleep;

        logger.info('Endpoint manager initialized | Endpoints: %d', this.endpoints.length);
    }

    get endpointCount(): number {
        return this.endpoints.length;
    }

    /**
     * Acquires an endpoint within the manager's configured acquisition timeout.
     *
     * The acquisition timeout is independent of the per-request HTTP timeout
     * used by FetchOperation.
     *
     * @throws {EndpointAcquisitionTimeoutError} If no endpoint becomes available
     *   within the configured acquireTimeout.
     * @throws {CallerAbortedError} If `signal` is aborted before acquisition.
     */
    async acquireEndpoint(signal: AbortSignal): Promise<EndpointHandle> {
        const acquisitionDeadline = this.clock() + this.acquireTimeout;

        while (true) {
            // Check cancellation before reading the clock or touching any endpoint.
            if (signal.aborted) {
                throw new CallerAbortedError();
            }

            // Read the clock once per iteration so endpoint scanning uses one
            // consistent timestamp for both availability and timeout calculations.
            const currentTime = this.clock();
            const remaining = acquisitionDeadline - currentTime;

            if (remaining <= 0) {
                throw new EndpointAcquisitionTimeoutError(this.acquireTimeout, this.endpoints.length);
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

            // Never wait longer than the remaining acquisition timeout.
            await this.sleep(Math.min(shortestWait, remaining), signal);
        }
    }

    async close(): Promise<void> {
        await Promise.all(this.endpoints.map((ep) => ep.close()));
        logger.info('Endpoint manager closed | Endpoints released: %d', this.endpoints.length);
    }
}
