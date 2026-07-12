import {ProxyAgent} from "undici";

const ips = process.env.PROXY_IP

const proxyAgents = ips
    .split(',')
    .map(url => url.trim())
    .filter(p => p.startsWith('http'))
    .map(url => {
        return {
            url: url,
            dispatcher: new ProxyAgent({
                uri: url,
                connections: 5,
                pipelining: 1,
                keepAliveTimeout: 60_000,
                headersTimeout: 10_000,
                bodyTimeout: 30_000
            })
        };
    });

let currentIndex = 0;

export function getRandomProxyDispatcher() {
    if (proxyAgents.length === 0) return undefined;

    const agent = proxyAgents[currentIndex];
    currentIndex = (currentIndex + 1) % proxyAgents.length;
    return agent;
}
