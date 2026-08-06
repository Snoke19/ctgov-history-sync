import { Limiter } from '../limiter/limiter.js';
import { HttpTransport } from './transport/transport.js';

export class Endpoint {
    private readonly handle: EndpointHandle;
    private closePromise?: Promise<void>;

    constructor(
        readonly url: string,
        private readonly limiter: Limiter,
        transport: HttpTransport,
    ) {
        this.handle = Object.freeze({
            url,
            transport,
        });
    }

    getHandle(): EndpointHandle {
        return this.handle;
    }

    tryAcquire(now: number): boolean {
        return this.limiter.tryAcquire(now);
    }

    timeUntilToken(now: number): number {
        return this.limiter.timeUntilToken(now);
    }

    close(): Promise<void> {
        return (this.closePromise ??= this.handle.transport.close());
    }
}

export interface EndpointHandle {
    readonly url: string;
    readonly transport: HttpTransport;
}
