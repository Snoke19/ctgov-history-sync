import type { Endpoint } from '../endpoint.js';
import { EndpointManager } from './endpointManager.js';

export interface EndpointManagerFactory {
    create(endpoints: readonly Endpoint[]): EndpointManager;
}
