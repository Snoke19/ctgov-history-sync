import {ProxyAgent} from 'undici';
import {
    ACQUIRE_TIMEOUT,
    POOL_CONNECTIONS,
    PROXY_IPS,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
} from '../config/config.js';
import {logger} from '../config/logging.js';
import {TokenBucket} from "./tokenBucket.js";
import {poolFactory} from "./poolFactory.js";

const PROXY_REGEX = /^(https?):\/\/([^:@/]+):([^@/]+)@([^:@/]+):(\d+)$/;

const proxyAgents = [];
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
            limiter: new TokenBucket(RATE_LIMIT_CAPACITY, RATE_LIMIT_WINDOW)
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

    const availableProxy = proxyAgents
        .map(proxy => ({proxy, tokens: proxy.limiter.peekTokens()}))
        .filter(item => item.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens);

    if (availableProxy.length > 0) {
        const pick = availableProxy[Math.floor(Math.random() * availableProxy.length)];

        await pick.proxy.limiter.acquire(timeoutMs);
        return pick.proxy;
    }

    let soonest = proxyAgents[0];
    let waitMs = soonest.limiter.timeUntil(1);

    for (let i = 1; i < proxyAgents.length; i++) {
        const proxy = proxyAgents[i];
        const wait = proxy.limiter.timeUntil(1);

        if (wait < waitMs) {
            waitMs = wait;
            soonest = proxy;
        }
    }

    await soonest.limiter.acquire(timeoutMs);

    return soonest;
}
