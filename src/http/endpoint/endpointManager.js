import {performance} from 'node:perf_hooks';
import {logger} from '../../config/logging.js';
import {ConfigurationError, EndpointAcquisitionTimeoutError} from '../../error/errors.ts';
import {setTimeout as sleep} from 'node:timers/promises';
import {TokenBucket} from '../limiter/tokenBucket.js';
import {UnlimitedLimiter} from '../limiter/unlimitedLimiter.js';
import {DirectEndpoint} from './directEndpoint.js';
import {createProxyEndpoints} from './proxyEndpoints.js';
import {assertPositiveInt} from "../../utils/validation.js";

const now = () => performance.now();

export class EndpointManager {
    #endpoints = [];
    #nextIndex = 0;
    #acquireTimeout = 0;

    constructor({
                    useProxy = true,
                    proxyUrls,
                    useRateLimit = true,
                    rateLimitCapacity,
                    rateLimitWindow,
                    acquireTimeout,
                    concurrency,
                    poolConfig,
                }) {

        assertPositiveInt(acquireTimeout, 'acquireTimeout');

        if (useRateLimit) {
            assertPositiveInt(rateLimitCapacity, 'rateLimitCapacity');
            assertPositiveInt(rateLimitWindow, 'rateLimitWindow');
        }

        const createLimiter = () => {
            return useRateLimit
                ? new TokenBucket(rateLimitCapacity, rateLimitWindow)
                : new UnlimitedLimiter();
        };

        if (useProxy) {
            if (typeof proxyUrls !== 'string' || proxyUrls.trim() === '') {
                throw new ConfigurationError('proxyUrls must be a non-empty string when useProxy is enabled.');
            }

            if (!poolConfig) {
                throw new ConfigurationError('poolConfig is required when useProxy is enabled.');
            }

            const endpoints = createProxyEndpoints(proxyUrls, createLimiter, {concurrency, poolConfig});

            if (endpoints.length === 0) {
                throw new ConfigurationError('useProxy is enabled, but no valid proxy URLs were configured.');
            }

            this.#endpoints.push(...endpoints);
        } else {
            this.#endpoints.push(new DirectEndpoint('direct', createLimiter()));
        }

        this.#acquireTimeout = acquireTimeout;

        logger.info('Endpoint manager initialized | Endpoints: %d', this.#endpoints.length);
    }

    get endpointCount() {
        return this.#endpoints.length;
    }

    /**
     * Acquires a ready endpoint using a round-robin polling loop.
     *
     * WHY a polling loop rather than TokenBucket.acquire():
     *   The manager arbitrates across *multiple* endpoints simultaneously.
     *   Each iteration scans all endpoints and picks the first one whose
     *   TokenBucket has a token ready (tryAcquire). It also tracks the
     *   shortest wait across all buckets so it can sleep only as long as
     *   needed before re-checking.
     *
     *   TokenBucket.acquire() is single-bucket and blocking; using it would
     *   require acquiring each endpoint sequentially, which breaks the
     *   round-robin rotation and can stall behind a slow proxy when a fast
     *   one is available. The polling loop is the correct design here.
     *
     * @param {number} [timeoutMs]
     * @returns {Promise<{url: string, dispatcher: *}>}
     * @throws {EndpointAcquisitionTimeoutError}
     */
    async acquireEndpoint(timeoutMs = this.#acquireTimeout) {
        const deadline = now() + timeoutMs;

        while (true) {
            const currentTime = now();
            let shortestWait = Infinity;

            for (let i = 0; i < this.#endpoints.length; i++) {
                const index = (this.#nextIndex + i) % this.#endpoints.length;
                const endpoint = this.#endpoints[index];

                if (endpoint.tryAcquire(currentTime)) {
                    this.#nextIndex = (index + 1) % this.#endpoints.length;
                    return endpoint.getHandle();
                }

                shortestWait = Math.min(shortestWait, endpoint.timeUntilToken(currentTime));
            }

            const remaining = deadline - now();
            if (remaining <= 0) {
                throw new EndpointAcquisitionTimeoutError(timeoutMs, this.#endpoints.length);
            }

            await sleep(Math.min(shortestWait, remaining));
        }
    }

    async close() {
        await Promise.all(this.#endpoints.map((ep) => ep.close()));
        logger.info('Endpoint manager closed | Endpoints released: %d', this.#endpoints.length);
    }
}
