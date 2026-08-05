import { Limiter } from '../limiter/limiter.js';
import type { AcquiredEndpointHandle } from './types/endpoints.js';

export abstract class Endpoint {
    private readonly url: string;
    private readonly limiter: Limiter;

    constructor(url: string, limiter: Limiter) {
        this.url = url;
        this.limiter = limiter;
    }

    getUrl(): string {
        return this.url;
    }

    tryAcquire(now: number): boolean {
        return this.limiter ? this.limiter.tryAcquire(now) : true;
    }

    timeUntilToken(now: number): number {
        return this.limiter ? this.limiter.timeUntilToken(now) : 0;
    }

    abstract getHandle(): AcquiredEndpointHandle;

    abstract close(): Promise<void>;
}
