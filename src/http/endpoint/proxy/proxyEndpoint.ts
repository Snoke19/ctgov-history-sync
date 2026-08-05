import { Endpoint } from '../endpoint.js';
import type { Limiter } from '../../limiter/limiter.js';
import { ProxyEndpointHandle } from '../types/endpoints.js';
import { HttpTransport } from '../types/transport.js';

export class ProxyEndpoint extends Endpoint {
    private readonly handle: ProxyEndpointHandle;
    private closePromise?: Promise<void>;

    constructor(proxyUrl: string, limiter: Limiter, transport: HttpTransport) {
        if (!limiter) throw new TypeError('ProxyEndpoint requires a limiter');
        if (!transport) throw new TypeError('ProxyEndpoint requires a transport');

        super(proxyUrl, limiter);

        this.handle = Object.freeze({
            url: proxyUrl,
            transport,
        });
    }

    public getHandle(): ProxyEndpointHandle {
        return this.handle;
    }

    public close(): Promise<void> {
        if (!this.closePromise) {
            this.closePromise = this.handle.transport.close();
        }

        return this.closePromise;
    }
}
