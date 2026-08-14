import type { HttpClientOptions } from '../../http.js';
import type { Limiter } from '../limiter.js';

export interface LimiterFactory {
    create(options: HttpClientOptions): Limiter;
}
