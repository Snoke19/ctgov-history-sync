import {Limiter} from "../limiter/limiter.js";
import { EndpointHandle } from "./types/endpoints.js";

export abstract class Endpoint {
    private readonly url: string;
    private readonly  limiter: Limiter;

    constructor(url: string, limiter: Limiter) {
        if (new.target === Endpoint) {
            throw new TypeError('Endpoint is abstract and cannot be instantiated directly');
        }

        this.url = url;
        this.limiter = limiter;
    }

    getUrl() {
        return this.url;
    }

    tryAcquire(now: number) {
        return this.limiter ?
            this.limiter.tryAcquire(now)
            : true;
    }

    timeUntilToken(now: number) {
        return this.limiter ?
            this.limiter.timeUntilToken(now)
            : 0;
    }

    abstract getHandle(): EndpointHandle;

    abstract close(): Promise<void>;
}
