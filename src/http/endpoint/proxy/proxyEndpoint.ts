import {Dispatcher} from 'undici';
import {Endpoint} from '../endpoint.js';
import type {Limiter} from '../../limiter/limiter.js';
import {ProxyEndpointHandle} from '../types/endpoints.js';

export class ProxyEndpoint extends Endpoint {
    private readonly handle: ProxyEndpointHandle;
    private closePromise?: Promise<void>;

    constructor(proxyUrl: string, limiter: Limiter, dispatcher: Dispatcher) {
        if (!limiter) throw new TypeError('DirectEndpoint requires a limiter');
        if (!dispatcher) throw new TypeError('ProxyEndpoint requires a dispatcher');

        super(proxyUrl, limiter);

        // Optional runtime safeguard – ensures the contract is fulfilled
        // (TypeScript already checks this at compile time, but this protects
        //  against plain JS callers or malformed objects)
        if (typeof (dispatcher as any).request !== 'function' || typeof (dispatcher as any).close !== 'function') {
            throw new TypeError('Provided dispatcher does not implement the required Dispatcher contract');
        }

        this.handle = Object.freeze({
            url: proxyUrl,
            dispatcher,
        });
    }

    public getHandle(): ProxyEndpointHandle {
        return this.handle;
    }

    public close(): Promise<void> {
        if (!this.closePromise) {
            this.closePromise = this.handle.dispatcher.close();
        }

        return this.closePromise;
    }
}
