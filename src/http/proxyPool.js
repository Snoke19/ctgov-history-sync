import {performance} from 'node:perf_hooks';
import {ProxyAgent} from 'undici';

import {
    ACQUIRE_TIMEOUT,
    POOL_CONNECTIONS,
    PROXY_IPS,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
} from '../config/config.js';

import {logger} from '../config/logging.js';
import {TokenBucketTimeoutError} from '../error/errors.js';
import {poolFactory} from './poolFactory.js';
import {TokenBucket} from './tokenBucket.js';

const PROXY_REGEX = /^(https?):\/\/([^:@/]+):([^:@/]+)@([^:@/]+):(\d+)$/;

const now = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const proxyAgents = [];
let nextProxyIndex = 0;

if (process.env.NODE_ENV !== 'test' && PROXY_IPS.length > 0) {
    for (const raw of PROXY_IPS.split(',')) {
        const url = raw.trim();

        if (!PROXY_REGEX.test(url)) {
            logger.warn(`[Proxy] Skipping invalid proxy URL: "${url}"`);
            continue;
        }

        proxyAgents.push({
            url,
            dispatcher: new ProxyAgent({uri: url, clientFactory: poolFactory}),
            limiter: new TokenBucket(RATE_LIMIT_CAPACITY, RATE_LIMIT_WINDOW),
        });
    }
}

logger.info(
    'Proxy pool initialized | Count: %d | RateLimit: %d/%dms | Connections: %d',
    proxyAgents.length,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    POOL_CONNECTIONS,
);

export async function acquireProxyDispatcher(timeoutMs = ACQUIRE_TIMEOUT) {
    if (proxyAgents.length === 0) {
        return undefined;
    }

    const deadline = now() + timeoutMs;

    while (true) {
        let shortestWait = Infinity;

        for (let i = 0; i < proxyAgents.length; i++) {
            const index = (nextProxyIndex + i) % proxyAgents.length;
            const proxy = proxyAgents[index];

            if (proxy.limiter.tryAcquire()) {
                nextProxyIndex = (index + 1) % proxyAgents.length;
                return proxy;
            }

            shortestWait = Math.min(
                shortestWait,
                proxy.limiter.timeUntil(1),
            );
        }

        const remaining = deadline - now();

        if (remaining <= 0) {
            throw new TokenBucketTimeoutError(timeoutMs);
        }

        await sleep(Math.min(shortestWait, remaining));
    }
}
