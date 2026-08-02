import {Limiter} from './limiter.js';

export class UnlimitedLimiter extends Limiter {
    tryAcquire(now) {
        return true;
    }

    timeUntilToken(now) {
        return 0;
    }
}
