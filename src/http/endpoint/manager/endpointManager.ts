import { performance } from 'node:perf_hooks';
import { setTimeout as nodeTimersSleep } from 'node:timers/promises';
import { Endpoint, EndpointHandle } from '../endpoint.js';
import { ConfigurationError, EndpointAcquisitionTimeoutError } from '../../../error/errors.js';
import { assertPositiveInt } from '../../../utils/validation.js';
import { logger } from '../../../config/logging.js';

type ClockFn = () => number;
type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

// Production defaults are module-level so they are not re-created per instance
// and do not appear in test output as noise.
const defaultClock: ClockFn = () => performance.now();
const defaultSleep: SleepFn = (ms, signal) =>
    nodeTimersSleep(ms, undefined, signal !== undefined ? { signal } : undefined);

export class EndpointManager {
    private readonly endpoints: readonly Endpoint[];
    private readonly acquireTimeout: number;
    private readonly clock: ClockFn;
    private readonly sleep: SleepFn;
    private nextIndex = 0;

    /**
     * @param endpoints       Pre-built endpoint list (at least one required).
     * @param acquireTimeout  Default timeout in ms for {@link acquireEndpoint}.
     * @param clock           Wall-clock source. Defaults to `performance.now()`.
     *                        Inject a fake in tests to drive timing deterministically.
     * @param sleep           Async delay. Defaults to `timers/promises.setTimeout`.
     *                        Inject a jest.fn() in tests to skip real waits.
     */
    constructor(
        endpoints: readonly Endpoint[],
        acquireTimeout: number,
        clock: ClockFn = defaultClock,
        sleep: SleepFn = defaultSleep,
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

    async acquireEndpoint(
        timeoutMs = this.acquireTimeout,
        signal?: AbortSignal,
    ): Promise<EndpointHandle> {
        const deadline = this.clock() + timeoutMs;

        while (true) {
            // AbortSignal is checked before the clock read so that an already-aborted
            // signal surfaces immediately, even before any deadline evaluation.
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }

            // Single clock read per iteration to keep the endpoint scan and deadline
            // check consistent — avoids skew between the two.
            const currentTime = this.clock();
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

            // Sleep for the shortest wait across all endpoints, but never past
            // the deadline — this keeps the loop responsive to timeouts.
            await this.sleep(Math.min(shortestWait, remaining), signal);
        }
    }

    async close(): Promise<void> {
        await Promise.all(this.endpoints.map((ep) => ep.close()));
        logger.info('Endpoint manager closed | Endpoints released: %d', this.endpoints.length);
    }
}
