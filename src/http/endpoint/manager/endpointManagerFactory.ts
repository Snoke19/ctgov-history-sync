import type { HttpClientOptions } from '../../types/http.js';
import { EndpointFactory } from '../endpointFactory.js';
import { EndpointManager } from './endpointManager.js';

/**
 * Composes {@link EndpointFactory} and {@link EndpointManager} into a single
 * creation step for callers that work with {@link HttpClientOptions}.
 *
 * This is the only public entry point that knows about both classes, keeping
 * each focused on a single responsibility:
 *
 *   HttpClientOptions
 *       │
 *       ▼
 *   EndpointManagerFactory.create()
 *       ├─► EndpointFactory.build()   — validates + constructs endpoints
 *       └─► new EndpointManager()     — manages acquire/release loop
 *
 * The `endpointFactory` parameter exists purely for testing:
 * supply a stub factory to control which endpoints the manager receives
 * without touching real network infrastructure.
 */
export class EndpointManagerFactory {
    constructor(private readonly endpointFactory: EndpointFactory) {}

    create(options: HttpClientOptions): EndpointManager {
        const endpoints = this.endpointFactory.build(options);
        return new EndpointManager(endpoints, options.acquireTimeout, options.clock?.now, options.sleep);
    }
}
