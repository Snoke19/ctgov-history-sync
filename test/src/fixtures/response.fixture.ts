import { jest } from '@jest/globals';

export function jsonResponse<T>(
    body: T,
    status = 200,
    headers: Record<string, string> = {},
    statusText = 'OK',
): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        statusText,
        headers: {
            'content-type': 'application/json',
            ...headers,
        },
    });
}

export function mockFetchResponse(
    status: number,
    body: unknown,
    statusText: string,
    headers: Record<string, string> = {},
): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, status, headers, statusText));
}

export function mock404Response(body: unknown): jest.SpiedFunction<typeof fetch> {
    return mockFetchResponse(404, body, 'Not Found');
}

export function mock204Response(): jest.SpiedFunction<typeof fetch> {
    return mockFetchResponse(204, null, 'No Content');
}
