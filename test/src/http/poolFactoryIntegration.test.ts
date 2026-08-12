import { createServer as createHttpServer, Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'undici';
import { ProxyPoolConfig } from '../../../src/config/config.js';
import { createPoolFactory } from '../../../src/http/poolFactory.js';

const POOL_CONFIG: ProxyPoolConfig = {
    connections: 2,
    maxConnections: 4,
    pipelining: 1,
    keepAliveTimeout: 5_000,
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
    connectTimeout: 5_000,
};

describe('createPoolFactory integration (real undici Pool)', () => {
    let server: Server;
    let baseUrl: string;
    let pool: Pool;

    beforeAll(async () => {
        server = createHttpServer((req, res) => {
            res.setHeader('content-type', 'application/json');

            if (req.url === '/missing') {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }

            res.end(JSON.stringify({ path: req.url ?? '', ok: true }));
        });

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });

        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('server did not bind to a TCP port');
        }

        baseUrl = `http://127.0.0.1:${address.port}`;
        pool = createPoolFactory(POOL_CONFIG)(baseUrl);
    });

    afterAll(async () => {
        await pool.close();
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    it('performs a real HTTP request through the pool', async () => {
        const { statusCode, headers, body } = await pool.request({ method: 'GET', path: '/json', headers: {} });

        expect(statusCode).toBe(200);
        expect(headers['content-type']).toContain('application/json');
        expect(await body.json()).toEqual({ path: '/json', ok: true });
    });

    it('honors a per-pool connections override', async () => {
        const customPool = createPoolFactory(POOL_CONFIG)(baseUrl, { connections: 1 });
        const { statusCode, body } = await customPool.request({ method: 'GET', path: '/custom', headers: {} });

        expect(statusCode).toBe(200);
        expect(await body.json()).toEqual({ path: '/custom', ok: true });

        await customPool.close();
    });

    it('passes the query string through to the server', async () => {
        const { statusCode, body } = await pool.request({ method: 'GET', path: '/search?page=2', headers: {} });

        expect(statusCode).toBe(200);
        expect(await body.json()).toEqual({ path: '/search?page=2', ok: true });
    });

    it('surfaces non-2xx status codes', async () => {
        const { statusCode, body } = await pool.request({ method: 'GET', path: '/missing', headers: {} });

        expect(statusCode).toBe(404);
        expect(await body.json()).toEqual({ error: 'not found' });
    });
});
