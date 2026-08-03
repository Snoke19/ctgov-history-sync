import {performance} from 'node:perf_hooks';
import {logger} from '../../config/logging.js';
import {ConfigurationError, EndpointAcquisitionTimeoutError} from '../../error/errors.js';
import {setTimeout as sleep} from 'node:timers/promises';
import {TokenBucket} from '../limiter/tokenBucket.js';
import {UnlimitedLimiter} from '../limiter/unlimitedLimiter.js';
import {DirectEndpoint} from './directEndpoint.js';
import {createProxyEndpoints} from './proxyEndpoints.js';
import {assertPositiveInt} from "../../utils/validation.js";
import {HttpClientOptions} from "../types/http.js";
import {Endpoint} from "./endpoint.js";

const now = () => performance.now();

export class EndpointManager {
    private endpoints: Endpoint[] = [];
    private nextIndex: number = 0;
    private acquireTimeout: number = 0;

    constructor(options: HttpClientOptions) {

        assertPositiveInt(options.acquireTimeout, 'acquireTimeout');

        if (options.useRateLimit) {
            assertPositiveInt(options.rateLimitCapacity, 'rateLimitCapacity');
            assertPositiveInt(options.rateLimitWindow, 'rateLimitWindow');
        }

        const createLimiter = () => {
            return options.useRateLimit
                ? new TokenBucket(options.rateLimitCapacity, options.rateLimitWindow)
                : new UnlimitedLimiter();
        };

        if (options.useProxy) {
            if (typeof options.proxyUrls !== 'string' || options.proxyUrls.trim() === '') {
                throw new ConfigurationError('proxyUrls must be a non-empty string when useProxy is enabled.');
            }

            if (!options.poolConfig) {
                throw new ConfigurationError('poolConfig is required when useProxy is enabled.');
            }

            const endpoints = createProxyEndpoints(options.proxyUrls, createLimiter, options.concurrency, options.poolConfig);

            if (endpoints.length === 0) {
                throw new ConfigurationError('useProxy is enabled, but no valid proxy URLs were configured.');
            }

            this.endpoints.push(...endpoints);
        } else {
            this.endpoints.push(new DirectEndpoint('direct', createLimiter()));
        }

        this.acquireTimeout = options.acquireTimeout;

        logger.info('Endpoint manager initialized | Endpoints: %d', this.endpoints.length);
    }

    get endpointCount() {
        return this.endpoints.length;
    }

    async acquireEndpoint(timeoutMs = this.acquireTimeout) {
        const deadline = now() + timeoutMs;

        while (true) {
            const currentTime = now();
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

            const remaining = deadline - now();
            if (remaining <= 0) {
                throw new EndpointAcquisitionTimeoutError(timeoutMs, this.endpoints.length);
            }

            await sleep(Math.min(shortestWait, remaining));
        }
    }

    async close() {
        await Promise.all(this.endpoints.map((ep) => ep.close()));
        logger.info('Endpoint manager closed | Endpoints released: %d', this.endpoints.length);
    }
}
