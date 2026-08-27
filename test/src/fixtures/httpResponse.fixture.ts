import { jest } from '@jest/globals';

import type { HttpResponse } from '../../../src/http/transport/httpTransport.js';

type MockHttpResponse = Omit<HttpResponse, 'discard' | 'json' | 'text'> & {
    discard: jest.MockedFunction<HttpResponse['discard']>;
    json: jest.MockedFunction<HttpResponse['json']>;
    text: jest.MockedFunction<HttpResponse['text']>;
};

export function createMockHttpResponse(overrides: Partial<MockHttpResponse> = {}): MockHttpResponse {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        discard: jest.fn<HttpResponse['discard']>().mockResolvedValue(undefined),
        json: jest.fn<HttpResponse['json']>().mockResolvedValue({ ok: true }),
        text: jest.fn<HttpResponse['text']>().mockResolvedValue(''),
        ...overrides,
    };
}
