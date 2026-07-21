import {Pool} from "undici";
import {
    POOL_BODY_TIMEOUT,
    POOL_CONNECTIONS,
    POOL_HEADERS_TIMEOUT,
    POOL_KEEP_ALIVE_TIMEOUT,
    POOL_PIPELINING
} from "../config/config.js";

export const poolFactory = (url, opts) => {
    return new Pool(url, {
        ...opts,
        connections: POOL_CONNECTIONS,
        pipelining: POOL_PIPELINING,
        keepAliveTimeout: POOL_KEEP_ALIVE_TIMEOUT,
        headersTimeout: POOL_HEADERS_TIMEOUT,
        bodyTimeout: POOL_BODY_TIMEOUT,
    });
};
