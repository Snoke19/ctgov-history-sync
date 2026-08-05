import { FetchTransport } from './fetchTransport.js';
import type { HttpTransport } from '../types/transport.js';
import { DirectTransportFactory } from './directTransportFactory.js';

/**
 * Production {@link DirectTransportFactory} that returns a {@link FetchTransport}.
 *
 * {@link FetchTransport} is stateless, so each call produces a fresh instance.
 * If a singleton is preferred, wrap this factory at the composition root.
 */
export class FetchTransportFactory implements DirectTransportFactory {
    create(): HttpTransport {
        return new FetchTransport();
    }
}
