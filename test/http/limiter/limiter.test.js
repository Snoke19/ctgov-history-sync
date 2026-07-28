import {describe, expect, test} from '@jest/globals';
import {Limiter} from '../../../src/http/limiter/limiter.js';

describe('Limiter', () => {
    test('tryAcquire() throws "Not implemented" by default', () => {
        const limiter = new Limiter();
        expect(() => limiter.tryAcquire()).toThrow('Not implemented');
    });

    test('timeUntilToken() throws "Not implemented" by default', () => {
        const limiter = new Limiter();
        expect(() => limiter.timeUntilToken()).toThrow('Not implemented');
    });

    test('is designed to be subclassed (methods can be overridden)', () => {
        class CustomLimiter extends Limiter {
            tryAcquire() {
                return true;
            }

            timeUntilToken() {
                return 0;
            }
        }

        const limiter = new CustomLimiter();
        expect(limiter.tryAcquire()).toBe(true);
        expect(limiter.timeUntilToken()).toBe(0);
    });
});
