import {describe, expect, test} from '@jest/globals';
import {UnlimitedLimiter} from "../../../src/http/limiter/unlimitedLimiter.js";
import {Limiter} from "../../../src/http/limiter/limiter.js";

describe('UnlimitedLimiter', () => {
    test('extends Limiter', () => {
        expect(new UnlimitedLimiter()).toBeInstanceOf(Limiter);
    });

    test('tryAcquire() always returns true', () => {
        const limiter = new UnlimitedLimiter();
        for (let i = 0; i < 5; i++) {
            expect(limiter.tryAcquire()).toBe(true);
        }
    });

    test('timeUntilToken() always returns 0', () => {
        const limiter = new UnlimitedLimiter();
        expect(limiter.timeUntilToken()).toBe(0);
        expect(limiter.tryAcquire() && limiter.timeUntilToken()).toBe(0);
    });
});