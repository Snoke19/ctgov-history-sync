import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../limiter.js';

export interface LimiterFactory {
    create(options: HttpClientOptions): Limiter;
}
