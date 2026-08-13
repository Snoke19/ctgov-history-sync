import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { logger } from '../../../src/config/logging.js';
import { TrialFetchError } from '../../../src/error/errors.js';
import { drainBody, parseOkResponseBody } from '../../../src/http/responseBody.js';
import { HttpResponse } from '../../../src/http/transport/httpTransport.js';

interface FakeHeaders {
    get(name: string): string | null;
}

function makeHeaders(contentType?: string): FakeHeaders {
    return {
        get: (name: string) => {
            if (name.toLowerCase() === 'content-type' && contentType !== undefined) return contentType;
            return null;
        },
    };
}

function makeResponse(
    overrides: Partial<Omit<HttpResponse, 'headers'>> & { headers?: FakeHeaders } = {},
): HttpResponse {
    const discard = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    return {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: makeHeaders('application/json'),
        text: async () => '',
        json: async () => ({ nctId: 'NCT00000001' }),
        discard,
        ...overrides,
    } as HttpResponse;
}

describe('drainBody', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('does nothing when the response has no discard method', async () => {
        const response = { ok: true } as HttpResponse;
        await expect(drainBody(response)).resolves.toBeUndefined();
    });

    it('calls discard when present', async () => {
        const response = makeResponse();
        await drainBody(response);
        expect(response.discard).toHaveBeenCalledTimes(1);
    });

    it('swallows errors thrown by discard', async () => {
        const response = makeResponse({
            discard: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('connection reset')),
        });
        await expect(drainBody(response)).resolves.toBeUndefined();
    });
});

describe('parseOkResponseBody', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('throws a non-transient TrialFetchError when the response is not ok', async () => {
        const response = makeResponse({ ok: false, status: 502 });
        const promise = parseOkResponseBody(response, 'https://api.test');

        await expect(promise).rejects.toBeInstanceOf(TrialFetchError);
        await expect(promise).rejects.toMatchObject({ status: 502, isTransient: false });
    });

    it('returns null for 204 No Content and drains the body', async () => {
        const response = makeResponse({ status: 204, json: jest.fn<() => Promise<unknown>>() });
        const result = await parseOkResponseBody(response, 'https://api.test');

        expect(result).toBeNull();
        expect(response.discard).toHaveBeenCalledTimes(1);
    });

    it('parses and returns the JSON body of an ok response', async () => {
        const response = makeResponse();
        const result = await parseOkResponseBody(response, 'https://api.test');

        expect(result).toEqual({ nctId: 'NCT00000001' });
        expect(response.discard).not.toHaveBeenCalled();
    });

    it('drains the body and throws when JSON parsing fails', async () => {
        const response = makeResponse({
            json: jest.fn<() => Promise<unknown>>().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
        });

        const promise = parseOkResponseBody(response, 'https://api.test');

        await expect(promise).rejects.toBeInstanceOf(TrialFetchError);
        await expect(promise).rejects.toMatchObject({ status: 200, isTransient: false });
        await expect(promise).rejects.toMatchObject({
            cause: expect.objectContaining({ message: expect.stringMatching(/Invalid JSON response/) }),
        });
        expect(response.discard).toHaveBeenCalledTimes(1);
    });

    it('logs a warning for an unexpected Content-Type but still parses', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const response = makeResponse({ headers: makeHeaders('text/html') });

        const result = await parseOkResponseBody(response, 'https://api.test');

        expect(result).toEqual({ nctId: 'NCT00000001' });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith('Unexpected Content-Type "%s" for %s', 'text/html', 'https://api.test');
    });

    it('warns when the Content-Type header is missing entirely', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const response = makeResponse({ headers: makeHeaders() });

        await parseOkResponseBody(response, 'https://api.test');

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith('Unexpected Content-Type "%s" for %s', '', 'https://api.test');
    });

    it('does not warn for an application/json Content-Type', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const response = makeResponse();

        await parseOkResponseBody(response, 'https://api.test');

        expect(warnSpy).not.toHaveBeenCalled();
    });
});
