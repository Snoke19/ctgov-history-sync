import {Pool, ProxyAgent} from 'undici';

class TokenBucket {
    #capacity;
    #tokens;
    #windowMs;
    #lastRefill;

    constructor(capacity, windowMs) {
        this.#capacity = capacity;
        this.#tokens = capacity;
        this.#windowMs = windowMs;
        this.#lastRefill = Date.now();
    }

    async acquire() {
        for (; ;) {
            const now = Date.now();
            const elapsed = now - this.#lastRefill;
            const refill = elapsed * (this.#capacity / this.#windowMs);
            if (refill > 0) {
                this.#tokens = Math.min(this.#capacity, this.#tokens + refill);
                this.#lastRefill = now;
            }
            if (this.#tokens >= 1) {
                this.#tokens -= 1;
                return;
            }
            await new Promise(r => setTimeout(r, this.#windowMs / this.#capacity));
        }
    }
}

const raw = []

const poolFactory = (url, opts) => {
    return new Pool(url, {
        ...opts,
        connections: 5,
        pipelining: 1,
        keepAliveTimeout: 60_000,
        headersTimeout: 10_000,
        bodyTimeout: 30_000,
    });
};

const proxyAgents = (process.env.NODE_ENV === 'test' || !raw || raw.length === 0) ? [] : raw
    .split(',')
    .map(url => url.trim())
    .filter(url => url.startsWith('http'))
    .map(url => ({
        url,
        dispatcher: new ProxyAgent({uri: url, clientFactory: poolFactory}),
        limiter: new TokenBucket(45, 60_000),
    }));

let currentIndex = 0;

export async function acquireProxyDispatcher() {
    if (proxyAgents.length === 0) return undefined;
    const agent = proxyAgents[currentIndex];
    currentIndex = (currentIndex + 1) % proxyAgents.length;
    await agent.limiter.acquire();
    return agent;
}
