import {Pool} from 'undici';
import {
    PROXY_POOL_BODY_TIMEOUT,
    PROXY_POOL_CONNECTIONS,
    PROXY_POOL_HEADERS_TIMEOUT,
    PROXY_POOL_KEEP_ALIVE_TIMEOUT,
    PROXY_POOL_PIPELINING,
} from '../config/config.js';

export const poolFactory = (url, opts) => {
    return new Pool(url, {
        ...opts,
        connections: PROXY_POOL_CONNECTIONS,
        pipelining: PROXY_POOL_PIPELINING,
        keepAliveTimeout: PROXY_POOL_KEEP_ALIVE_TIMEOUT,
        headersTimeout: PROXY_POOL_HEADERS_TIMEOUT,
        bodyTimeout: PROXY_POOL_BODY_TIMEOUT,
    });
};
