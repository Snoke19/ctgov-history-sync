import { logger } from '../../../config/logging.js';
import { CallerAbortedError, ConfigurationError, EndpointAcquisitionTimeoutError } from '../../../error/errors.js';
import { assertPositiveInt } from '../../../utils/validation.js';
import { defaultMonotonicClock, defaultSleeper, MonotonicClock, Sleeper } from '../../clock.js';
import { Endpoint, EndpointHandle } from '../endpoint.js';

type EndpointManagerErrorLogContext = {
    error: unknown;
    endpointCount: number;
};

function createEndpointManagerErrorLogContext(error: unknown, endpointCount: number): EndpointManagerErrorLogContext {
    return {
        error,
        endpointCount,
    };
}

export class EndpointManager {
    private readonly endpoints: readonly Endpoint[];
    private readonly acquireTimeout: number;
    private readonly clock: MonotonicClock['now'];
    private readonly sleep: Sleeper['sleep'];
    private nextIndex = 0;

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

    async acquireEndpoint(signal: AbortSignal): Promise<EndpointHandle> {
        const acquisitionDeadline = this.clock() + this.acquireTimeout;

        while (true) {
            if (signal.aborted) {
                throw new CallerAbortedError();
            }

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

            await this.sleep(Math.min(shortestWait, remaining), signal);
        }
    }

    async close(): Promise<void> {
        try {
            await Promise.all(this.endpoints.map((ep) => ep.close()));
            logger.info('Endpoint manager closed | Endpoints released: %d', this.endpoints.length);
        } catch (error) {
            logger.error(
                createEndpointManagerErrorLogContext(error, this.endpoints.length),
                'Failed to close endpoint manager',
            );

            throw error;
        }
    }
}
