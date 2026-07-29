import {performance} from 'node:perf_hooks';
import {ACQUIRE_TIMEOUT, PROXY_URLS} from '../../config/config.js';
import {logger} from '../../config/logging.js';
import {ConfigurationError, EndpointAcquisitionTimeoutError} from '../../error/errors.js';
import {sleep} from '../../utils/sleep.js';
import {TokenBucket} from '../limiter/tokenBucket.js';
import {UnlimitedLimiter} from '../limiter/unlimitedLimiter.js';
import {DirectEndpoint} from './directEndpoint.js';
import {createProxyEndpoints} from './proxyEndpoints.js';

const now = () => performance.now();

export class EndpointManager {
    #endpoints = [];
    #nextIndex = 0;

    constructor({useProxy = true, useRateLimit = true, rateLimitCapacity, rateLimitWindow}) {
        if (useRateLimit) {
            if (!Number.isInteger(rateLimitCapacity) || rateLimitCapacity <= 0) {
                throw new ConfigurationError(
                    'rateLimitCapacity must be a positive integer when rate limiting is enabled.',
                );
            }

            if (!Number.isInteger(rateLimitWindow) || rateLimitWindow <= 0) {
                throw new ConfigurationError(
                    'rateLimitWindow must be a positive integer when rate limiting is enabled.',
                );
            }
        }

        const createLimiter = () => {
            if (!useRateLimit) {
                return new UnlimitedLimiter();
            }

            return new TokenBucket(rateLimitCapacity, rateLimitWindow);
        };

        if (useProxy) {
            this.#endpoints.push(...createProxyEndpoints(PROXY_URLS, createLimiter));
        }

        if (this.#endpoints.length === 0) {
            this.#endpoints.push(new DirectEndpoint('direct', createLimiter()));
        }

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
    async acquireEndpoint(timeoutMs = ACQUIRE_TIMEOUT) {
        const deadline = now() + timeoutMs;

        while (true) {
            let shortestWait = Infinity;

            for (let i = 0; i < this.#endpoints.length; i++) {
                const index = (this.#nextIndex + i) % this.#endpoints.length;
                const endpoint = this.#endpoints[index];

                if (endpoint.tryAcquire()) {
                    this.#nextIndex = (index + 1) % this.#endpoints.length;
                    return endpoint.getHandle();
                }

                shortestWait = Math.min(shortestWait, endpoint.timeUntilToken());
            }

            const remaining = deadline - now();
            if (remaining <= 0) {
                throw new EndpointAcquisitionTimeoutError(timeoutMs, this.#endpoints.length);
            }

            await sleep(Math.min(shortestWait, remaining));
        }
    }

    /**
     * Closes all endpoint dispatchers, releasing connection pools.
     * Call this on process shutdown (SIGTERM/SIGINT) to avoid connection leaks.
     *
     * @returns {Promise<void>}
     */
    async close() {
        await Promise.all(this.#endpoints.map((ep) => ep.close()));
        logger.info('Endpoint manager closed | Endpoints released: %d', this.#endpoints.length);
    }
}
