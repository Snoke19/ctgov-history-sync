import type { HttpTransport } from '../types/transport.js';

/**
 * Factory for creating a direct (non-proxy) HTTP transport.
 *
 * Deliberately kept separate from {@link TransportFactory} so the direct
 * transport path carries no proxy-specific parameters (proxyUrl, proxyCount,
 * poolConfig), and each can evolve independently.
 *
 * To swap the HTTP library for direct requests:
 *   1. Implement `HttpTransport` (e.g. `AxiosDirectTransport`).
 *   2. Implement this interface (e.g. `AxiosDirectTransportFactory`).
 *   3. Pass the factory to {@link DirectEndpointProvider} at the composition root.
 */
export interface DirectTransportFactory {
    create(): HttpTransport;
}
