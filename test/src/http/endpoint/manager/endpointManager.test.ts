import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EndpointManager } from '../../../../../src/http/endpoint/manager/endpointManager.js';
import {
    CallerAbortedError,
    ConfigurationError,
    EndpointAcquisitionTimeoutError,
} from '../../../../../src/error/errors.js';
import { Endpoint, EndpointHandle } from '../../../../../src/http/endpoint/endpoint.js';
import { HttpTransport } from '../../../../../src/http/endpoint/transport/httpTransport.js';

const makeHandle = (url = 'http://fake', id?: string): EndpointHandle => ({
    url,
    transport: { close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) } as unknown as HttpTransport,
    ...(id ? { id } : {}),
});

const makeEndpoint = (overrides?: Partial<Record<keyof Endpoint, any>>): jest.Mocked<Endpoint> =>
    ({
        url: 'http://fake',
        tryAcquire: jest.fn().mockReturnValue(false),
        timeUntilToken: jest.fn().mockReturnValue(100),
        getHandle: jest.fn().mockReturnValue(makeHandle()),
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        ...overrides,
    }) as unknown as jest.Mocked<Endpoint>;

function clockSequence(...values: number[]): () => number {
    let i = 0;
    const last = values[values.length - 1] ?? 0;
    return () => {
        const v = values[i];
        if (v !== undefined) {
            i++;
            return v;
        }
        return last;
    };
}

const abortedSignal = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
};

const liveSignal = (): AbortSignal => new AbortController().signal;

const instantSleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});

const createManager = (options?: {
    endpoints?: Endpoint[];
    timeout?: number;
    clock?: () => number;
    sleep?: (_ms: number, _signal?: AbortSignal) => Promise<void>;
}) => {
    const endpoints = options?.endpoints ?? [makeEndpoint()];
    const timeout = options?.timeout ?? 1000;
    const clock = options?.clock ?? clockSequence(0);
    const sleep = options?.sleep ?? instantSleep;
    return new EndpointManager(endpoints, timeout, clock, sleep);
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('EndpointManager', () => {
    describe('constructor', () => {
        const clock = clockSequence(0);

        test('throws ConfigurationError for an empty endpoint list', () => {
            expect(() => new EndpointManager([], 1000, clock, instantSleep)).toThrow(ConfigurationError);
        });

        /**
         * assertPositiveInt must reject all of these.
         * If someone loosens the validation (e.g. allows 0 "for flexibility"),
         * the deadline math would produce a zero-width window and always time out.
         */
        test.each([
            [0, 'zero'],
            [-1, 'negative'],
            [-100, 'large negative'],
            [0.5, 'non-integer float'],
            [999.9, 'float close to integer'],
        ])('throws for acquireTimeout = %i (%s)', (timeout) => {
            expect(() => new EndpointManager([makeEndpoint()], timeout, clock, instantSleep)).toThrow();
        });

        test('accepts the minimum valid timeout of 1 ms', () => {
            expect(() => new EndpointManager([makeEndpoint()], 1, clockSequence(0), instantSleep)).not.toThrow();
        });

        test('endpointCount matches the array passed to the constructor', () => {
            const mgr = createManager({
                endpoints: [makeEndpoint(), makeEndpoint(), makeEndpoint()],
                timeout: 500,
            });
            expect(mgr.endpointCount).toBe(3);
        });
    });

    describe('AbortSignal handling', () => {
        /**
         * The abort check must fire BEFORE the endpoint scan.
         * If someone swaps the order, a prematurely-aborted signal would still
         * call tryAcquire — potentially releasing or mutating limiter state.
         */
        test('pre-aborted signal throws AbortError before any endpoint is touched', async () => {
            const ep = makeEndpoint({ tryAcquire: jest.fn().mockReturnValue(true) });
            const mgr = createManager({ endpoints: [ep] });

            await expect(mgr.acquireEndpoint(1000, abortedSignal())).rejects.toThrow(
                new CallerAbortedError('The operation was aborted.'),
            );

            expect(ep.tryAcquire).not.toHaveBeenCalled();
        });

        /**
         * In the loop body, the order is: [abort check] → [clock read] → [deadline check].
         * This test pins that order: even when the deadline is already past, an aborted
         * signal must surface as AbortError, not EndpointAcquisitionTimeoutError.
         *
         * It also verifies the clock is only called once (for the deadline), confirming
         * that the loop's `this.clock()` call is never reached when signal is aborted.
         */
        test('AbortError wins over an expired deadline — abort is checked before the clock read', async () => {
            const clock = jest.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(1001);

            const mgr = createManager({ clock });
            const err = await mgr.acquireEndpoint(1000, abortedSignal()).catch((e) => e);

            expect(err).toBeInstanceOf(CallerAbortedError);
            expect(err).toHaveProperty('message', 'The operation was aborted.');
            expect(clock).toHaveBeenCalledTimes(1);
        });

        /**
         * Simulates abort arriving between two loop iterations (e.g., the caller
         * decides to cancel while we're sleeping between retries).
         */
        test('throws AbortError when signal is aborted during a sleep', async () => {
            const controller = new AbortController();
            const ep = makeEndpoint({ tryAcquire: jest.fn().mockReturnValue(false) });

            let sleepCount = 0;
            const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {
                if (++sleepCount === 1) controller.abort();
            });

            const mgr = createManager({ endpoints: [ep], timeout: 100_000, sleep });

            await expect(mgr.acquireEndpoint(100_000, controller.signal)).rejects.toThrow(
                new CallerAbortedError('The operation was aborted.'),
            );

            expect(sleepCount).toBe(1);
        });

        /**
         * The signal must be forwarded to sleep() so that real `timers/promises.setTimeout`
         * can wake up early when aborted — instead of waiting for the full sleep duration.
         */
        test('passes the AbortSignal through to the sleep function', async () => {
            const ep = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValueOnce(false).mockReturnValue(true),
                getHandle: jest.fn().mockReturnValue(makeHandle()),
            });
            const sig = liveSignal();
            const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
            const mgr = createManager({ endpoints: [ep], timeout: 10_000, sleep });

            await mgr.acquireEndpoint(10_000, sig);

            expect(sleep).toHaveBeenCalledWith(expect.any(Number), sig);
        });
    });

    describe('timeout handling', () => {
        test('throws EndpointAcquisitionTimeoutError when the deadline is past on the first iteration', async () => {
            const mgr = createManager({ clock: clockSequence(0, 1001) });

            await expect(mgr.acquireEndpoint(1000, liveSignal())).rejects.toBeInstanceOf(
                EndpointAcquisitionTimeoutError,
            );
        });

        /**
         * The condition is `remaining <= 0`, not `remaining < 0`.
         * remaining === 0 means the deadline has been hit — sleeping 0 ms and retrying
         * would be a spin loop with no progress guarantee. It must be treated as expired.
         */
        test('treats remaining === 0 as timed out (boundary: <= 0, not < 0)', async () => {
            const mgr = createManager({ clock: clockSequence(0, 1000) });

            await expect(mgr.acquireEndpoint(1000, liveSignal())).rejects.toBeInstanceOf(
                EndpointAcquisitionTimeoutError,
            );
        });

        /**
         * Without this cap the process could sleep PAST the deadline and only detect
         * the timeout one full sleep duration later, giving a much worse latency bound.
         */
        test('sleep duration is capped at the remaining time when shortestWait exceeds it', async () => {
            const ep = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValue(false),
                timeUntilToken: jest.fn().mockReturnValue(500),
            });
            const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
            const mgr = createManager({ endpoints: [ep], clock: clockSequence(0, 800, 1001), sleep });

            await mgr.acquireEndpoint(1000, liveSignal()).catch(() => {});

            expect(sleep).toHaveBeenCalledWith(200, expect.anything());
        });

        /**
         * If all endpoints report Infinity (no rate limit), shortestWait stays Infinity.
         * Math.min(Infinity, remaining) must fall back to remaining — not actually sleep forever.
         */
        test('falls back to remaining time when timeUntilToken returns Infinity', async () => {
            const ep = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValueOnce(false).mockReturnValue(true),
                timeUntilToken: jest.fn().mockReturnValue(Infinity),
                getHandle: jest.fn().mockReturnValue(makeHandle()),
            });
            const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
            const mgr = createManager({
                endpoints: [ep],
                timeout: 10_000,
                clock: clockSequence(0, 3_000, 3_000),
                sleep,
            });

            await mgr.acquireEndpoint(10_000, liveSignal());

            expect(sleep).toHaveBeenCalledWith(7_000, expect.anything());
        });

        /**
         * The timeout argument passed per-call must override the constructor default.
         * Without this, a shorter per-call timeout would be silently ignored.
         */
        test('per-call timeout overrides the constructor default', async () => {
            const mgr = createManager({ timeout: 5_000, clock: clockSequence(0, 101) });

            await expect(mgr.acquireEndpoint(100, liveSignal())).rejects.toBeInstanceOf(
                EndpointAcquisitionTimeoutError,
            );
        });
    });

    describe('endpoint scanning & round-robin', () => {
        test('returns the handle immediately when the first endpoint is available', async () => {
            const handle = makeHandle('http://fake', 'first');
            const ep = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValue(true),
                getHandle: jest.fn().mockReturnValue(handle),
            });
            const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
            const mgr = createManager({ endpoints: [ep], sleep });

            expect(await mgr.acquireEndpoint(1000, liveSignal())).toBe(handle);
            expect(sleep).not.toHaveBeenCalled();
        });

        test('iterates past busy endpoints and picks the first available one', async () => {
            const handle = makeHandle('http://c', 'C');
            const epA = makeEndpoint({ tryAcquire: jest.fn().mockReturnValue(false) });
            const epB = makeEndpoint({ tryAcquire: jest.fn().mockReturnValue(false) });
            const epC = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValue(true),
                getHandle: jest.fn().mockReturnValue(handle),
            });
            const mgr = createManager({ endpoints: [epA, epB, epC] });

            expect(await mgr.acquireEndpoint(1000, liveSignal())).toBe(handle);
            expect(epA.tryAcquire).toHaveBeenCalled();
            expect(epB.tryAcquire).toHaveBeenCalled();
        });

        /**
         * After acquiring endpoint[i], nextIndex must advance to i+1 so the next
         * call starts from the following endpoint — the core of fair round-robin.
         * If nextIndex isn't updated, every call would hammer endpoint[0].
         */
        test('nextIndex advances past the acquired endpoint — next call starts from there', async () => {
            const handleA = makeHandle('http://a', 'A');
            const handleB = makeHandle('http://b', 'B');
            const handleC = makeHandle('http://c', 'C');

            const epA = makeEndpoint({ getHandle: jest.fn().mockReturnValue(handleA) });
            const epB = makeEndpoint({ getHandle: jest.fn().mockReturnValue(handleB) });
            const epC = makeEndpoint({ getHandle: jest.fn().mockReturnValue(handleC) });

            epA.tryAcquire.mockReturnValueOnce(true);
            epB.tryAcquire.mockReturnValueOnce(true);

            const mgr = createManager({ endpoints: [epA, epB, epC], timeout: 10_000 });

            expect(await mgr.acquireEndpoint(10_000, liveSignal())).toBe(handleA);
            expect(await mgr.acquireEndpoint(10_000, liveSignal())).toBe(handleB);

            // If nextIndex hadn't advanced, C would be scanned on call 2. It shouldn't be.
            expect(epC.tryAcquire).not.toHaveBeenCalled();
        });

        /**
         * When the LAST endpoint in the list is acquired, nextIndex must wrap to 0.
         * Without the modulo, nextIndex would go out of bounds or skip index 0 forever.
         */
        test('nextIndex wraps to 0 after acquiring the last endpoint', async () => {
            const handleA = makeHandle('http://a', 'A');
            const handleB = makeHandle('http://b', 'B');

            const epA = makeEndpoint({ getHandle: jest.fn().mockReturnValue(handleA) });
            const epB = makeEndpoint({ getHandle: jest.fn().mockReturnValue(handleB) });

            epB.tryAcquire.mockReturnValueOnce(true);

            const mgr = createManager({ endpoints: [epA, epB], timeout: 10_000 });
            await mgr.acquireEndpoint(10_000, liveSignal());

            epA.tryAcquire.mockReturnValueOnce(true);

            const r2 = await mgr.acquireEndpoint(10_000, liveSignal());

            expect(r2).toBe(handleA);
            expect(epB.tryAcquire).toHaveBeenCalledTimes(1);
        });

        /**
         * Once an endpoint is acquired, scanning must stop immediately.
         * Endpoints further down the list should not have tryAcquire or timeUntilToken called.
         */
        test('does not scan endpoints after the acquired one in the same iteration', async () => {
            const epA = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValue(true),
                getHandle: jest.fn().mockReturnValue(makeHandle('http://a')),
            });
            const epB = makeEndpoint({ tryAcquire: jest.fn().mockReturnValue(true) });
            const mgr = createManager({ endpoints: [epA, epB] });

            await mgr.acquireEndpoint(1000, liveSignal());

            expect(epB.tryAcquire).not.toHaveBeenCalled();
            expect(epB.timeUntilToken).not.toHaveBeenCalled();
        });

        /**
         * The comment in the source says "Single clock read per iteration".
         * This pins that contract: 1 call for the deadline + exactly 1 per loop iteration.
         * A second read inside the scan loop would introduce clock skew between
         * the tryAcquire call and the deadline check.
         */
        test('reads the clock exactly once per loop iteration (1 deadline + 1 per iteration)', async () => {
            const ep = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValueOnce(false).mockReturnValue(true),
                getHandle: jest.fn().mockReturnValue(makeHandle()),
            });
            const clock = jest.fn<() => number>().mockReturnValue(0);
            const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
            const mgr = createManager({ endpoints: [ep], timeout: 10_000, clock, sleep });

            await mgr.acquireEndpoint(10_000, liveSignal());

            expect(clock).toHaveBeenCalledTimes(3);
        });

        /**
         * `tryAcquire` and `timeUntilToken` must receive the SAME timestamp within
         * one iteration — not two separate clock reads that could diverge under load.
         */
        test('tryAcquire and timeUntilToken receive the same currentTime within one iteration', async () => {
            const receivedTimes: number[] = [];
            const ep = makeEndpoint({
                tryAcquire: jest.fn((t: number) => {
                    receivedTimes.push(t);
                    return false;
                }),
                timeUntilToken: jest.fn((t: number) => {
                    receivedTimes.push(t);
                    return 100;
                }),
            });

            const mgr = createManager({ endpoints: [ep], clock: clockSequence(0, 42, 1001) });
            await mgr.acquireEndpoint(1000, liveSignal()).catch(() => {});

            expect(receivedTimes).toEqual([42, 42]);
        });

        /**
         * Sleep duration must be the MINIMUM across all busy endpoints, not the first
         * or the maximum. Sleeping longer than necessary adds unnecessary latency.
         */
        test('sleeps for the minimum timeUntilToken across all busy endpoints', async () => {
            const epSlow = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValue(false),
                timeUntilToken: jest.fn().mockReturnValue(300),
            });
            const epFast = makeEndpoint({
                tryAcquire: jest.fn().mockReturnValueOnce(false).mockReturnValue(true),
                timeUntilToken: jest.fn().mockReturnValue(50),
                getHandle: jest.fn().mockReturnValue(makeHandle()),
            });
            const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
            const mgr = createManager({ endpoints: [epSlow, epFast], timeout: 10_000, sleep });

            await mgr.acquireEndpoint(10_000, liveSignal());

            expect(sleep).toHaveBeenCalledWith(50, expect.anything());
        });
    });

    describe('close()', () => {
        test('calls close() exactly once on every endpoint', async () => {
            const eps = [makeEndpoint(), makeEndpoint(), makeEndpoint()];
            const mgr = createManager({ endpoints: eps });

            await mgr.close();

            eps.forEach((ep) => expect(ep.close).toHaveBeenCalledTimes(1));
        });

        /**
         * close() uses Promise.all — all endpoints must be closed concurrently.
         * We verify by checking that all close() calls are dispatched synchronously
         * before any of them resolve, which is only possible with Promise.all (not a loop
         * of sequential awaits).
         */
        test('closes all endpoints concurrently, not sequentially', async () => {
            const callOrder: string[] = [];
            const resolvers: Array<() => void> = [];

            const tracked = (id: string) =>
                makeEndpoint({
                    close: jest.fn(() => {
                        callOrder.push(id);
                        return new Promise<void>((resolve) => resolvers.push(resolve));
                    }),
                });

            const eps = [tracked('A'), tracked('B'), tracked('C')];
            const mgr = createManager({ endpoints: eps });

            const closing = mgr.close();

            expect(callOrder).toEqual(['A', 'B', 'C']);

            resolvers.forEach((r) => r());
            await closing;
        });

        /**
         * Documents that close() uses Promise.all, not Promise.allSettled.
         * A single failing endpoint propagates the rejection to the caller.
         * If the desired contract ever changes to "close all regardless of errors",
         * this test is the place to update — and the implementation change is then obvious.
         */
        test('rejects if any endpoint close() rejects (Promise.all, not allSettled)', async () => {
            const good = makeEndpoint();
            const bad = makeEndpoint({
                close: jest.fn(() => Promise.reject(new Error('release timeout'))),
            });

            const mgr = createManager({ endpoints: [good, bad] });

            await expect(mgr.close()).rejects.toThrow('release timeout');
        });
    });
});
