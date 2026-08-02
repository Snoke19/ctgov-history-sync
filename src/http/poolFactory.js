import {Pool} from 'undici';

export const createPoolFactory = (poolConfig) => (url, opts = {}) => {
    const {connections, connect, ...rest} = opts;

    return new Pool(url, {
        ...rest,
        connections: connections ?? poolConfig.connections,
        pipelining: poolConfig.pipelining,
        keepAliveTimeout: poolConfig.keepAliveTimeout,
        headersTimeout: poolConfig.headersTimeout,
        bodyTimeout: poolConfig.bodyTimeout,
        connect: {
            timeout: poolConfig.connectTimeout,
            ...connect,
        },
    });
};
