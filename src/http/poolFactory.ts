import {Pool} from 'undici';
import {ProxyPoolConfig} from '../config/config.js';

interface PoolFactoryOptions {
    connections?: number;
    connect?: {
        timeout?: number;
        [key: string]: unknown;
    };

    [key: string]: unknown;
}

export const createPoolFactory = (poolConfig: ProxyPoolConfig) =>
    (url: string | URL, opts: PoolFactoryOptions = {}): Pool => {
        const {connections, connect = {}, ...rest} = opts;

        return new Pool(url, {
            ...rest,
            connections: connections ?? poolConfig.connections,
            pipelining: poolConfig.pipelining,
            keepAliveTimeout: poolConfig.keepAliveTimeout,
            headersTimeout: poolConfig.headersTimeout,
            bodyTimeout: poolConfig.bodyTimeout,
            connect: {
                timeout: connect.timeout ?? poolConfig.connectTimeout,
                ...connect,
            },
        });
    };