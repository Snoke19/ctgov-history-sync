import {Pool, ProxyAgent} from 'undici';

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
        dispatcher: new ProxyAgent({
            uri: url,
            clientFactory: poolFactory,
        }),
    }));

let currentIndex = 0;

/**
 * Returns the next proxy dispatcher in round-robin order,
 * or undefined when no proxies are configured.
 *
 * @returns {{ url: string, dispatcher: ProxyAgent } | undefined}
 */
export function getRandomProxyDispatcher() {
    if (proxyAgents.length === 0) return undefined;
    const agent = proxyAgents[currentIndex];
    currentIndex = (currentIndex + 1) % proxyAgents.length;
    return agent;
}
