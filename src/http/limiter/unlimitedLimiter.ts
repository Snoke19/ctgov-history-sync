import { Limiter } from './limiter.js';

export class UnlimitedLimiter extends Limiter {
    tryAcquire(_now: number): boolean {
        return true;
    }

    timeUntilToken(_now: number): number {
        return 0;
    }
}
