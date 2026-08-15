import type { Limiter } from '../limiter.js';

export interface LimiterFactory {
    create(): Limiter;
}