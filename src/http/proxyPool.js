import {performance} from 'node:perf_hooks';
import {
    ACQUIRE_TIMEOUT,
    POOL_CONNECTIONS,
    PROXY_IPS,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
} from '../config/config.js';
import {logger} from '../config/logging.js';
import {ProxyAcquisitionTimeoutError} from '../error/errors.js';
import {ProxyInstance} from "./proxyInstance.js";

const PROXY_REGEX = /^(https?):\/\/([^:@/]+):([^:@/]+)@([^:@/]+):(\d+)$/;

const now = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const proxies = [];
let nextProxyIndex = 0;

if (process.env.NODE_ENV !== 'test' && PROXY_IPS.length > 0) {
    for (const raw of PROXY_IPS.split(',')) {
        const url = raw.trim();

        if (!PROXY_REGEX.test(url)) {
            logger.warn(`[Proxy] Skipping invalid proxy URL: "${url}"`);
            continue;
        }

        proxies.push(new ProxyInstance(url));
    }
}

logger.info('Proxy pool initialized | Count: %d | RateLimit: %d/%dms | Connections: %d',
    proxies.length,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    POOL_CONNECTIONS,
);

export async function acquireProxy(timeoutMs = ACQUIRE_TIMEOUT) {
    if (proxies.length === 0) {
        return undefined;
    }

    const deadline = now() + timeoutMs;

    while (true) {
        let shortestWait = Infinity;

        for (let i = 0; i < proxies.length; i++) {
            const index = (nextProxyIndex + i) % proxies.length;
            const proxy = proxies[index];

            if (proxy.tryAcquire()) {
                nextProxyIndex = (index + 1) % proxies.length;
                return proxy.getHandle();
            }

            shortestWait = Math.min(
                shortestWait,
                proxy.timeUntilToken(),
            );
        }

        const remaining = deadline - now();
        if (remaining <= 0) {
            throw new ProxyAcquisitionTimeoutError(timeoutMs, proxies.length,);
        }

        await sleep(Math.min(shortestWait, remaining));
    }
}
