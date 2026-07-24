import {describe, expect, jest, test} from '@jest/globals';
import {DirectEndpoint} from "../../../src/http/endpoint/directEndpoint.js";
import {Endpoint} from "../../../src/http/endpoint/endpoint.js";

describe('DirectEndpoint', () => {
    test('extends Endpoint', () => {
        expect(new DirectEndpoint()).toBeInstanceOf(Endpoint);
    });

    test('defaults url to "direct" when not provided', () => {
        const endpoint = new DirectEndpoint();
        expect(endpoint.url).toBe('direct');
        expect(endpoint.getHandle().url).toBe('direct');
    });

    test('accepts a custom url', () => {
        const endpoint = new DirectEndpoint('custom-direct');
        expect(endpoint.url).toBe('custom-direct');
        expect(endpoint.getHandle().url).toBe('custom-direct');
    });

    test('getHandle() returns a handle with dispatcher undefined', () => {
        const endpoint = new DirectEndpoint();
        expect(endpoint.getHandle().dispatcher).toBeUndefined();
    });

    test('getHandle() returns a frozen object', () => {
        const endpoint = new DirectEndpoint();
        const handle = endpoint.getHandle();
        expect(Object.isFrozen(handle)).toBe(true);
        expect(() => {
            'use strict';
            handle.url = 'mutated';
        }).toThrow();
    });

    test('getHandle() always returns the same handle instance', () => {
        const endpoint = new DirectEndpoint();
        expect(endpoint.getHandle()).toBe(endpoint.getHandle());
    });

    test('tryAcquire()/timeUntilToken() still delegate to the given limiter', () => {
        const limiter = {
            tryAcquire: jest.fn(() => false),
            timeUntilToken: jest.fn(() => 42)
        };
        const endpoint = new DirectEndpoint('direct', limiter);

        expect(endpoint.tryAcquire()).toBe(false);
        expect(endpoint.timeUntilToken()).toBe(42);
    });

    test('works with no limiter at all (defaults to unrestricted)', () => {
        const endpoint = new DirectEndpoint('direct');
        expect(endpoint.tryAcquire()).toBe(true);
        expect(endpoint.timeUntilToken()).toBe(0);
    });
});