import { describe, expect, it, jest } from '@jest/globals';
import { adaptHttpResponse } from '../../../../../src/http/endpoint/transport/adaptHttpResponse.js';

describe('adaptHttpResponse', () => {
    it('maps response fields correctly', () => {
        const headers = new Headers({ 'content-type': 'application/json' });

        const response = {
            status: 201,
            statusText: 'Created',
            ok: true,
            headers,
            body: null,
            text: jest.fn<() => Promise<string>>().mockResolvedValue('raw text'),
            json: jest.fn<() => Promise<unknown>>().mockResolvedValue({ data: 42 }),
        };

        const result = adaptHttpResponse(response);

        expect(result.status).toBe(201);
        expect(result.statusText).toBe('Created');
        expect(result.ok).toBe(true);
        expect(result.headers).toBe(headers);
    });

    it('delegates text()', async () => {
        const response = {
            status: 200,
            statusText: 'OK',
            ok: true,
            headers: new Headers(),
            body: null,
            text: jest.fn<() => Promise<string>>().mockResolvedValue('raw text'),
            json: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
        };

        const result = adaptHttpResponse(response);

        await expect(result.text()).resolves.toBe('raw text');
        expect(response.text).toHaveBeenCalledTimes(1);
    });

    it('delegates json()', async () => {
        const response = {
            status: 200,
            statusText: 'OK',
            ok: true,
            headers: new Headers(),
            body: null,
            text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
            json: jest.fn<() => Promise<unknown>>().mockResolvedValue({ data: 42 }),
        };

        const result = adaptHttpResponse(response);

        await expect(result.json()).resolves.toEqual({ data: 42 });
        expect(response.json).toHaveBeenCalledTimes(1);
    });

    it('discards the body when present', async () => {
        const cancel = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

        const response = {
            status: 200,
            statusText: 'OK',
            ok: true,
            headers: new Headers(),
            body: {
                cancel,
            } as unknown as ReadableStream<unknown>,
            text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
            json: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
        };

        const result = adaptHttpResponse(response);

        await result.discard();

        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('does nothing when body is null', async () => {
        const response = {
            status: 200,
            statusText: 'OK',
            ok: true,
            headers: new Headers(),
            body: null,
            text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
            json: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
        };

        const result = adaptHttpResponse(response);

        await expect(result.discard()).resolves.toBeUndefined();
    });

    it('swallows body cancellation errors', async () => {
        const cancel = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('already closed'));

        const response = {
            status: 200,
            statusText: 'OK',
            ok: true,
            headers: new Headers(),
            body: {
                cancel,
            } as unknown as ReadableStream<unknown>,
            text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
            json: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
        };

        const result = adaptHttpResponse(response);

        await expect(result.discard()).resolves.toBeUndefined();
    });
});
