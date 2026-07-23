import {Limiter} from './limiter.js';

export class UnlimitedLimiter extends Limiter {
    tryAcquire() {
        return true;
    }

    timeUntilToken() {
        return 0;
    }
}
