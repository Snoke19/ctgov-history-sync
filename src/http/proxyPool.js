import {ProxyAgent} from 'undici';
import {
    ACQUIRE_TIMEOUT,
    POOL_CONNECTIONS,
    PROXY_IPS,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
} from '../config/config.js';
import {logger} from '../config/logging.js';
import {poolFactory} from './poolFactory.js';
import {TokenBucket} from './tokenBucket.js';

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
            dispatcher: new ProxyAgent({ uri: url, clientFactory: poolFactory }),
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

    const proxy = pickBestAvailableProxy() ?? pickSoonestProxy();

    await proxy.limiter.acquire(timeoutMs);

    return proxy;
}

function pickBestAvailableProxy() {
    let maxTokens = 0;
    const candidates = [];

    for (const proxy of proxyAgents) {
        const tokens = proxy.limiter.peekTokens();

        if (tokens <= 0) {
            continue;
        }

        if (tokens > maxTokens) {
            maxTokens = tokens;
            candidates.length = 0;
            candidates.push(proxy);
        } else if (tokens === maxTokens) {
            candidates.push(proxy);
        }
    }

    if (candidates.length === 0) {
        return undefined;
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickSoonestProxy() {
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

    return soonest;
}
