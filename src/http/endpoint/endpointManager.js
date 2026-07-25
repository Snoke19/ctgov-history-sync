import {ACQUIRE_TIMEOUT, PROXY_IPS} from "../../config/config.js";
import {logger} from "../../config/logging.js";
import {ProxyEndpoint} from "./proxyEndpoint.js";
import {DirectEndpoint} from "./directEndpoint.js";
import {EndpointAcquisitionTimeoutError} from "../../error/errors.js";
import {performance} from "node:perf_hooks";
import {TokenBucket} from "../limiter/tokenBucket.js";
import {UnlimitedLimiter} from "../limiter/unlimitedLimiter.js";

/**
 * Supported format:
 *
 *   http://user:password@host:port
 *   https://user:password@host:port
 *
 * Intentionally rejected:
 *
 * - socks proxies
 * - trailing slash
 * - usernames/passwords containing ':' or '@'
 * - missing credentials
 */
const PROXY_URL_REGEX = /^(https?):\/\/([^:@/]+):([^:@/]+)@([^:@/]+):(\d+)$/;

const now = () => performance.now();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class EndpointManager {

    #endpoints = [];
    #nextIndex = 0;

    constructor({useProxy = true, useRateLimit = true, rateLimitCapacity, rateLimitWindow}) {

        const createLimiter = () => {
            if (!useRateLimit) {
                return new UnlimitedLimiter();
            }

            return new TokenBucket(rateLimitCapacity, rateLimitWindow);
        };

        if (useProxy && PROXY_IPS && PROXY_IPS.length > 0) {
            for (const raw of String(PROXY_IPS).split(',')) {

                const url = raw.trim();

                if (!PROXY_URL_REGEX.test(url)) {
                    logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', url);

                    continue;
                }

                this.#endpoints.push(new ProxyEndpoint(url, createLimiter()));
            }
        }

        if (this.#endpoints.length === 0) {
            this.#endpoints.push(new DirectEndpoint('direct', createLimiter()));
        }

        logger.info('Endpoint manager initialized | Endpoints: %d', this.#endpoints.length);
    }


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

                shortestWait = Math.min(
                    shortestWait,
                    endpoint.timeUntilToken(),
                );
            }

            const remaining = deadline - now();
            if (remaining <= 0) {
                throw new EndpointAcquisitionTimeoutError(timeoutMs, this.#endpoints.length,);
            }

            await sleep(Math.min(shortestWait, remaining));
        }
    }
}
