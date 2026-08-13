import { DirectTransportFactory } from '../factory/directTransportFactory.js';
import type { HttpTransport } from '../httpTransport.js';
import { FetchDirectTransport } from './fetchDirectTransport.js';

export class FetchDirectTransportFactory implements DirectTransportFactory {
    create(): HttpTransport {
        return new FetchDirectTransport();
    }
}
