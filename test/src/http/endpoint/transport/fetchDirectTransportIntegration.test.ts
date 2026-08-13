import { createServer as createHttpServer, Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { FetchDirectTransport } from '../../../../../src/http/transport/impl/fetchDirectTransport.js';

describe('FetchDirectTransport integration (undici via global fetch)', () => {
    let server: Server;
    let baseUrl: string;
    let transport: FetchDirectTransport;

    beforeAll(async () => {
        server = createHttpServer((req, res) => {
            res.setHeader('content-type', 'application/json');

            if (req.url === '/missing') {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }

            if (req.method === 'POST') {
                let raw = '';
                req.on('data', (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                req.on('end', () => {
                    res.end(JSON.stringify({ method: 'POST', body: raw }));
                });
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
        transport = new FetchDirectTransport();
    });

    afterAll(async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    it('performs a real GET and maps status, headers and JSON body', async () => {
        const response = await transport.request({ url: `${baseUrl}/json`, method: 'GET', headers: {} });

        expect(response.status).toBe(200);
        expect(response.ok).toBe(true);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toEqual({ path: '/json', ok: true });
    });

    it('sends a GET request and receives the response', async () => {
        const response = await transport.request({
            url: `${baseUrl}/echo`,
            method: 'GET',
            headers: {},
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            ok: true,
            path: '/echo',
        });
    });

    it('maps a real 404 response', async () => {
        const response = await transport.request({ url: `${baseUrl}/missing`, method: 'GET', headers: {} });

        expect(response.status).toBe(404);
        expect(response.ok).toBe(false);
        expect(await response.json()).toEqual({ error: 'not found' });
    });

    it('reads the raw text body', async () => {
        const response = await transport.request({ url: `${baseUrl}/json`, method: 'GET', headers: {} });

        expect(await response.text()).toBe(JSON.stringify({ path: '/json', ok: true }));
    });
});
