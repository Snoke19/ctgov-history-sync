import { createLogger } from '../../../config/logging.js';
import {
    CallerAbortedError,
    ConfigurationError,
    EndpointAcquisitionTimeoutError,
    TrialError,
} from '../../../error/errors.js';
import { assertPositiveInt } from '../../../utils/validation.js';
import { defaultMonotonicClock, defaultSleeper, MonotonicClock, Sleeper } from '../../clock.js';
import { Endpoint, EndpointHandle } from '../endpoint.js';

const logger = createLogger(import.meta.url);

type EndpointManagerErrorLogContext = {
    err: unknown;
    endpointCount: number;
};

function createEndpointManagerErrorLogContext(error: unknown, endpointCount: number): EndpointManagerErrorLogContext {
    return {
        err: error,
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

                    logger.debug(
                        { endpointIndex: index, endpointCount: this.endpoints.length },
                        'Endpoint token acquired',
                    );

                    return endpoint.getHandle();
                }

                shortestWait = Math.min(shortestWait, endpoint.timeUntilToken(currentTime));
            }

            const waitMs = Math.min(shortestWait, remaining);

            logger.debug(
                {
                    endpointCount: this.endpoints.length,
                    waitMs,
                    acquireTimeoutMs: this.acquireTimeout,
                },
                'All endpoints busy; waiting for token',
            );

            await this.sleep(waitMs, signal);
        }
    }

    async close(): Promise<void> {
        try {
            await Promise.all(this.endpoints.map((ep) => ep.close()));
            logger.info('Endpoint manager closed | Endpoints released: %d', this.endpoints.length);
        } catch (error: unknown) {
            const trialError = TrialError.normalize(error);

            logger.error(
                createEndpointManagerErrorLogContext(trialError, this.endpoints.length),
                'Failed to close endpoint manager',
            );

            throw trialError;
        }
    }
}
