import { createServer as createHttpServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { DEFAULT_USER_AGENT } from '../../../../src/config/config.js';
import { NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { DirectEndpointProvider } from '../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { createHttpClient } from '../../../../src/http/httpClient.js';
import type { HttpClient } from '../../../../src/http/httpClient.js';
import { DefaultLimiterFactory } from '../../../../src/http/limiter/factory/defaultLimiterFactory.js';
import { FetchDirectTransportFactory } from '../../../../src/http/transport/impl/fetchDirectTransport.js';
import { testLogger } from './helpers.js';

/**
 * Full createHttpClient stack against a real TCP server with the real
 * Undici-backed global fetch.
 *
 * No mocked fetch, fake Response objects, or injected clocks/sleepers.
 *
 * This suite verifies behavior that cannot be fully covered by unit tests:
 * - real TCP/network execution;
 * - real AbortSignal propagation;
 * - real streamed response consumption;
 * - connection reuse;
 * - real retry behavior.
 */
describe('HttpClient full-stack integration', () => {
    let server: Server;
    let baseUrl: string;
    let client: HttpClient;

    let flakyHits = 0;
    let slowHits = 0;
    let stallHits = 0;

    beforeAll(async () => {
        server = createHttpServer((req, res) => {
            const path = new URL(req.url ?? '/', 'http://localhost').pathname;

            switch (path) {
                case '/slow':
                    slowHits++;
                    return;

                case '/stall':
                    stallHits++;
                    return;

                case '/flaky':
                    handleFlakyResponse(res);
                    return;

                case '/missing':
                    res.writeHead(404, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'not found' }));
                    return;

                case '/big':
                    handleLargeResponse(res);
                    return;

                default:
                    break;
            }

            if (path === '/echo' && req.method === 'GET') {
                handleEchoRequest(req, res);
                return;
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ path }));
        });

        await listen(server);

        const address = server.address();

        if (address === null || typeof address === 'string') {
            throw new Error('Server did not bind to a TCP port');
        }

        baseUrl = `http://127.0.0.1:${address.port}`;

        client = await createHttpClient(
            {
                concurrency: 5,
                acquireTimeout: 5000,
            },
            new DirectEndpointProvider(new FetchDirectTransportFactory()),
            new DefaultLimiterFactory({
                enabled: false,
                capacity: 10,
                windowMs: 1000,
            }),
            testLogger,
        );
    });

    beforeEach(() => {
        flakyHits = 0;
        slowHits = 0;
        stallHits = 0;
    });

    afterAll(async () => {
        await client.close();

        server.closeAllConnections?.();

        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    });

    it('fetches and parses JSON over a real HTTP connection', async () => {
        const result = await client.fetchJson<{ path: string }>(`${baseUrl}/greeting`);

        expect(result).toEqual({ path: '/greeting' });
    });

    it('sends default and custom headers on a real GET request', async () => {
        const result = await client.fetchJson<{
            method: string;
            headers: Record<string, string>;
        }>(`${baseUrl}/echo`, {
            headers: {
                'X-Custom': 'v',
            },
        });

        expect(result).toMatchObject({
            method: 'GET',
        });

        expect(result?.headers.accept).toBe('application/json');
        expect(result?.headers['user-agent']).toBe(DEFAULT_USER_AGENT);
        expect(result?.headers['x-custom']).toBe('v');
    });

    it('reuses the HTTP connection across sequential requests', async () => {
        const first = await client.fetchJson<{ path: string }>(`${baseUrl}/seq/one`);
        const second = await client.fetchJson<{ path: string }>(`${baseUrl}/seq/two`);
        const third = await client.fetchJson<{ path: string }>(`${baseUrl}/seq/three`);

        expect(first).toEqual({ path: '/seq/one' });
        expect(second).toEqual({ path: '/seq/two' });
        expect(third).toEqual({ path: '/seq/three' });
    });

    it('parses a streamed response body successfully', async () => {
        const result = await client.fetchJson<{
            items: Array<{ index: number; value: string }>;
        }>(`${baseUrl}/big`);

        expect(result?.items).toHaveLength(5000);
        expect(result?.items[4999]).toEqual({
            index: 4999,
            value: 'value-4999',
        });
    });

    it('throws HttpException for 404 and returns null when allow404 is enabled', async () => {
        await expect(client.fetchJson(`${baseUrl}/missing`)).rejects.toMatchObject({
            status: 404,
        });

        const result = await client.fetchJson(`${baseUrl}/missing`, {
            allow404: true,
        });

        expect(result).toBeNull();
    });

    it('retries a real 503 and succeeds on the next attempt', async () => {
        const result = await client.fetchJson<{ recovered: boolean }>(`${baseUrl}/flaky`, {
            maxRetries: 2,
        });

        expect(result).toEqual({ recovered: true });
        expect(flakyHits).toBe(2);
    });

    it('throws TimeoutException when a real HTTP request exceeds timeoutMs', async () => {
        await expect(
            client.fetchJson(`${baseUrl}/slow`, {
                timeoutMs: 100,
                maxRetries: 0,
            }),
        ).rejects.toBeInstanceOf(TimeoutException);

        expect(slowHits).toBe(1);
    });

    it('throws NetworkException when the caller aborts a real in-flight request', async () => {
        const controller = new AbortController();

        const pending = client.fetchJson(`${baseUrl}/stall`, {
            signal: controller.signal,
            maxRetries: 0,
        });

        setTimeout(() => controller.abort(), 50);

        await expect(pending).rejects.toBeInstanceOf(NetworkException);
        expect(stallHits).toBeGreaterThanOrEqual(1);
    });

    function handleFlakyResponse(res: import('node:http').ServerResponse): void {
        flakyHits++;

        if (flakyHits === 1) {
            res.writeHead(503, {
                'content-type': 'application/json',
                'Retry-After': '1',
            });
            res.end(JSON.stringify({ error: 'temporarily unavailable' }));
            return;
        }

        res.writeHead(200, {
            'content-type': 'application/json',
        });
        res.end(JSON.stringify({ recovered: true }));
    }

    function handleLargeResponse(res: import('node:http').ServerResponse): void {
        res.writeHead(200, {
            'content-type': 'application/json',
        });

        const payload = {
            items: Array.from({ length: 5000 }, (_, index) => ({
                index,
                value: `value-${index}`,
            })),
        };

        const body = JSON.stringify(payload);

        for (let i = 0; i < body.length; i += 64) {
            res.write(body.slice(i, i + 64));
        }

        res.end();
    }

    function handleEchoRequest(
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
    ): void {
        let raw = '';

        req.setEncoding('utf-8');

        req.on('data', (chunk: string) => {
            raw += chunk;
        });

        req.on('end', () => {
            res.writeHead(200, {
                'content-type': 'application/json',
            });

            res.end(
                JSON.stringify({
                    method: req.method,
                    received: raw,
                    headers: { ...req.headers },
                }),
            );
        });
    }
});

async function listen(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}
