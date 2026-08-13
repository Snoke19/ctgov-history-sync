import type { HttpTransport } from '../httpTransport.js';
import { FetchDirectTransport } from '../impl/fetchDirectTransport.js';
import { DirectTransportFactory } from './directTransportFactory.js';

export class FetchDirectTransportFactory implements DirectTransportFactory {
    create(): HttpTransport {
        return new FetchDirectTransport();
    }
}
