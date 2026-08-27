import { MonotonicClock, RandomSource, Sleeper, WallClock } from '../../../src/http/clock.js';

export interface TestClientOptions {
    readonly concurrency: number;
    readonly endpointAcquireTimeoutMs: number;
    readonly sleep: Sleeper['sleep'];
    readonly random: RandomSource['random'];
    readonly monotonicClock: MonotonicClock;
    readonly wallClock: WallClock;
}
