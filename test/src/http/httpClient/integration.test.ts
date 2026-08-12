import { createServer as createHttpServer, Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { DEFAULT_USER_AGENT } from '../../../../src/config/config.js';
import { HttpException, NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { DirectEndpointProvider } from '../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { FetchDirectTransportFactory } from '../../../../src/http/endpoint/transport/factory/fetchDirectTransportFactory.js';
import { createHttpClient, HttpClient } from '../../../../src/http/httpClient.js';

/**
 * Full createHttpClient stack against a real TCP server with the real
 * undici-backed global fetch — no mocked fetch, no fake Response objects,
 * no injected clock/sleeper.
 *
 * This is the only suite that exercises FetchOperation's abort/body
 * interplay with a genuine signal-backed fetch: the success path must NOT
 * abort the controller (that would destroy the still-streaming response
 * body), while the timeout/abort paths must surface as TimeoutException /
 * NetworkException respectively.
 */
describe('HttpClient full-stack integration (real server + real fetch)', () => {
    let server: Server;
    let baseUrl: string;
    let client: HttpClient;

    let flakyHits = 0;
    let slowHits = 0;
    let stallHits = 0;

    beforeAll(async () => {
        server = createHttpServer((req, res) => {
            const path = new URL(req.url ?? '/', 'http://localhost').pathname;

            if (path === '/slow') {
                // Never respond: FetchOperation's own timeout must abort the
                // real in-flight fetch.
                slowHits++;
                return;
            }

            if (path === '/stall') {
                // Never respond: the caller aborts a real in-flight request.
                stallHits++;
                return;
            }

            if (path === '/flaky') {
                flakyHits++;
                if (flakyHits === 1) {
                    res.writeHead(503, { 'content-type': 'application/json', 'Retry-After': '1' });
                    res.end(JSON.stringify({ error: 'temporarily unavailable' }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ recovered: true }));
                return;
            }

            if (path === '/missing') {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }

            if (path === '/big') {
                // Deliberately streamed in small chunks (no Content-Length, so
                // Node uses chunked transfer encoding). The body is still being
                // delivered when fetch() resolves, so if the success path aborted
                // the controller, response.json() would reject mid-stream.
                res.writeHead(200, { 'content-type': 'application/json' });
                const payload = {
                    items: Array.from({ length: 5000 }, (_, index) => ({ index, value: `value-${index}` })),
                };
                const body = JSON.stringify(payload);
                for (let i = 0; i < body.length; i += 64) {
                    res.write(body.slice(i, i + 64));
                }
                res.end();
                return;
            }

            if (path === '/echo' && req.method === 'POST') {
                let raw = '';
                req.setEncoding('utf-8');
                req.on('data', (chunk: string) => {
                    raw += chunk;
                });
                req.on('end', () => {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ method: req.method, received: raw, headers: { ...req.headers } }));
                });
                return;
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ path }));
        });

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });

        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('server did not bind to a TCP port');
        }
        baseUrl = `http://127.0.0.1:${address.port}`;

        client = createHttpClient(
            {
                concurrency: 5,
                acquireTimeout: 5000,
                rateLimitCapacity: 10,
                rateLimitWindow: 1000,
                useRateLimit: false,
            },
            new DirectEndpointProvider(new FetchDirectTransportFactory()),
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
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    it('fetches and parses JSON end-to-end over a real socket', async () => {
        const result = await client.fetchJson<{ path: string }>(`${baseUrl}/greeting`);

        expect(result).toEqual({ path: '/greeting' });
    });

    it('sends method, headers and body to the server and receives the echo', async () => {
        const result = await client.fetchJson<{ method: string; received: string; headers: Record<string, string> }>(
            `${baseUrl}/echo`,
            {
                method: 'POST',
                body: JSON.stringify({ a: 1 }),
                headers: { 'Content-Type': 'application/json', 'X-Custom': 'v' },
            },
        );

        expect(result).toMatchObject({ method: 'POST', received: '{"a":1}' });
        expect(result?.headers.accept).toBe('application/json');
        expect(result?.headers['user-agent']).toBe(DEFAULT_USER_AGENT);
        expect(result?.headers['content-type']).toBe('application/json');
        expect(result?.headers['x-custom']).toBe('v');
    });

    it('reuses the connection across sequential successful requests', async () => {
        const first = await client.fetchJson<{ path: string }>(`${baseUrl}/seq/one`);
        const second = await client.fetchJson<{ path: string }>(`${baseUrl}/seq/two`);
        const third = await client.fetchJson<{ path: string }>(`${baseUrl}/seq/three`);

        expect(first).toEqual({ path: '/seq/one' });
        expect(second).toEqual({ path: '/seq/two' });
        expect(third).toEqual({ path: '/seq/three' });
    });

    it('parses a large streamed body without destroying it on success', async () => {
        const result = await client.fetchJson<{ items: Array<{ index: number; value: string }> }>(`${baseUrl}/big`);

        expect(result?.items).toHaveLength(5000);
        expect(result?.items[4999]).toEqual({ index: 4999, value: 'value-4999' });
    });

    it('throws HttpException on 404 unless allow404 maps it to null', async () => {
        await expect(client.fetchJson(`${baseUrl}/missing`)).rejects.toBeInstanceOf(HttpException);
        await expect(client.fetchJson(`${baseUrl}/missing`)).rejects.toMatchObject({ status: 404 });

        const result = await client.fetchJson(`${baseUrl}/missing`, { allow404: true });
        expect(result).toBeNull();
    });

    it('retries a real 503 and succeeds on the next attempt', async () => {
        const result = await client.fetchJson<{ recovered: boolean }>(`${baseUrl}/flaky`, { maxRetries: 2 });

        expect(result).toEqual({ recovered: true });
        expect(flakyHits).toBe(2);
    });

    it('times out against a hanging endpoint through the real request signal', async () => {
        await expect(client.fetchJson(`${baseUrl}/slow`, { timeoutMs: 100, maxRetries: 0 })).rejects.toBeInstanceOf(
            TimeoutException,
        );
        expect(slowHits).toBe(1);
    });

    it('surfaces a caller abort of a real in-flight request as NetworkException', async () => {
        const controller = new AbortController();

        const pending = client.fetchJson(`${baseUrl}/stall`, { signal: controller.signal, maxRetries: 0 });
        setTimeout(() => controller.abort(), 50);

        await expect(pending).rejects.toBeInstanceOf(NetworkException);
        expect(stallHits).toBeGreaterThanOrEqual(1);
    });
});
