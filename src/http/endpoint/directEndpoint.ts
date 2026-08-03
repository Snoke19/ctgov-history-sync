import {Endpoint, EndpointHandle} from './endpoint.js';
import {Limiter} from "../limiter/limiter.js";

export class DirectEndpoint extends Endpoint {
    readonly handle: EndpointHandle;

    constructor(url: string = 'direct', limiter: Limiter) {
        super(url, limiter);
        this.handle = Object.freeze({url, dispatcher: undefined});
    }

    getHandle(): EndpointHandle {
        return this.handle;
    }

    close(): Promise<void> {
        return Promise.resolve();
    }
}
