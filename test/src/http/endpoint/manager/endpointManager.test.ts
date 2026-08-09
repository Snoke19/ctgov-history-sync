import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EndpointManager } from '../../../../../src/http/endpoint/manager/endpointManager.js';
import { ConfigurationError, EndpointAcquisitionTimeoutError } from '../../../../../src/error/errors.js';
import { Endpoint } from '../../../../../src/http/endpoint/endpoint.js';

function makeEndpoint(overrides: Partial<Endpoint> = {}) {
    return {
        url: 'http://fake',
        tryAcquire: jest.fn(() => false),
        timeUntilToken: jest.fn(() => 100),
        getHandle: jest.fn(() => ({ url: 'http://fake', transport: { close: jest.fn() } as any })),
        close: jest.fn(() => Promise.resolve()),
        ...overrides,
    } as unknown as Endpoint;
}

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

function abortedSignal(): AbortSignal {
    const c = new AbortController();
    c.abort();
    return c.signal;
}

const liveSignal = (): AbortSignal => new AbortController().signal;

const instantSleep = jest.fn(() => Promise.resolve());

beforeEach(() => {
    instantSleep.mockClear();
});

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
        const mgr = new EndpointManager(
            [makeEndpoint(), makeEndpoint(), makeEndpoint()],
            500,
            clockSequence(0),
            instantSleep,
        );
        expect(mgr.endpointCount).toBe(3);
    });
});

describe('AbortSignal', () => {
    /**
     * The abort check must fire BEFORE the endpoint scan.
     * If someone swaps the order, a prematurely-aborted signal would still
     * call tryAcquire — potentially releasing or mutating limiter state.
     */
    test('pre-aborted signal throws AbortError before any endpoint is touched', async () => {
        const ep = makeEndpoint({ tryAcquire: jest.fn(() => true) });
        const mgr = new EndpointManager([ep], 1000, clockSequence(0), instantSleep);

        await expect(mgr.acquireEndpoint(1000, abortedSignal())).rejects.toMatchObject({ name: 'AbortError' });

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
        // deadline = 0 + 1000 = 1000; loop's currentTime would be 1001 → remaining = -1
        // But the abort fires before the clock is read in the loop.
        const clock = jest.fn(() => 0);
        clock.mockReturnValueOnce(0); // deadline = 0 + 1000
        clock.mockReturnValueOnce(1001); // loop body (unreachable)

        const mgr = new EndpointManager([makeEndpoint()], 1000, clock, instantSleep);

        const err = await mgr.acquireEndpoint(1000, abortedSignal()).catch((e) => e);

        expect(err.name).toBe('AbortError');
        // Only the deadline read happened; the loop body's clock call is unreachable.
        expect(clock).toHaveBeenCalledTimes(1);
    });

    /**
     * Simulates abort arriving between two loop iterations (e.g., the caller
     * decides to cancel while we're sleeping between retries).
     */
    test('throws AbortError when signal is aborted during a sleep', async () => {
        const controller = new AbortController();
        const ep = makeEndpoint({ tryAcquire: jest.fn(() => false) });

        let sleepCount = 0;
        const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {
            if (++sleepCount === 1) controller.abort();
        });

        const mgr = new EndpointManager([ep], 100_000, clockSequence(0), sleep);

        await expect(mgr.acquireEndpoint(100_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

        expect(sleepCount).toBe(1); // slept exactly once, then caught the abort
    });

    /**
     * The signal must be forwarded to sleep() so that real `timers/promises.setTimeout`
     * can wake up early when aborted — instead of waiting for the full sleep duration.
     */
    test('passes the AbortSignal through to the sleep function', async () => {
        const ep = makeEndpoint({
            tryAcquire: jest
                .fn(() => false)
                .mockReturnValueOnce(false)
                .mockReturnValue(true),
            getHandle: jest.fn(() => ({ url: 'http://fake', transport: { close: jest.fn() } as any })),
        });
        const sig = liveSignal();
        const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
        const mgr = new EndpointManager([ep], 10_000, clockSequence(0), sleep);

        await mgr.acquireEndpoint(10_000, sig);

        expect(sleep).toHaveBeenCalledWith(expect.any(Number), sig);
    });
});

describe('timeout', () => {
    test('throws EndpointAcquisitionTimeoutError when the deadline is past on the first iteration', async () => {
        // deadline = 0 + 1000 = 1000; currentTime = 1001 → remaining = -1
        const mgr = new EndpointManager([makeEndpoint()], 1000, clockSequence(0, 1001), instantSleep);

        await expect(mgr.acquireEndpoint(1000, liveSignal())).rejects.toBeInstanceOf(EndpointAcquisitionTimeoutError);
    });

    /**
     * The condition is `remaining <= 0`, not `remaining < 0`.
     * remaining === 0 means the deadline has been hit — sleeping 0 ms and retrying
     * would be a spin loop with no progress guarantee. It must be treated as expired.
     */
    test('treats remaining === 0 as timed out (boundary: <= 0, not < 0)', async () => {
        // deadline = 1000; currentTime = 1000 → remaining = 0
        const mgr = new EndpointManager([makeEndpoint()], 1000, clockSequence(0, 1000), instantSleep);

        await expect(mgr.acquireEndpoint(1000, liveSignal())).rejects.toBeInstanceOf(EndpointAcquisitionTimeoutError);
    });

    /**
     * Without this cap the process could sleep PAST the deadline and only detect
     * the timeout one full sleep duration later, giving a much worse latency bound.
     */
    test('sleep duration is capped at the remaining time when shortestWait exceeds it', async () => {
        // Endpoint wants 500 ms; only 200 ms remain → sleep(min(500, 200)) = sleep(200)
        const ep = makeEndpoint({
            tryAcquire: jest.fn(() => false),
            timeUntilToken: jest.fn(() => 500),
        });
        const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
        // deadline = 1000; iter1 remaining = 200; iter2 → timeout
        const mgr = new EndpointManager([ep], 1000, clockSequence(0, 800, 1001), sleep);

        await mgr.acquireEndpoint(1000, liveSignal()).catch(() => {});

        expect(sleep).toHaveBeenCalledWith(200, expect.anything());
    });

    /**
     * If all endpoints report Infinity (no rate limit), shortestWait stays Infinity.
     * Math.min(Infinity, remaining) must fall back to remaining — not actually sleep forever.
     */
    test('falls back to remaining time when timeUntilToken returns Infinity', async () => {
        // remaining = 10_000 - 3_000 = 7_000; min(Infinity, 7_000) = 7_000
        const ep = makeEndpoint({
            tryAcquire: jest
                .fn(() => false)
                .mockReturnValueOnce(false)
                .mockReturnValue(true),
            timeUntilToken: jest.fn(() => Infinity),
            getHandle: jest.fn(() => ({ url: 'http://fake', transport: { close: jest.fn() } as any })),
        });
        const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
        const mgr = new EndpointManager([ep], 10_000, clockSequence(0, 3_000, 3_000), sleep);

        await mgr.acquireEndpoint(10_000, liveSignal());

        expect(sleep).toHaveBeenCalledWith(7_000, expect.anything());
    });

    /**
     * The timeout argument passed per-call must override the constructor default.
     * Without this, a shorter per-call timeout would be silently ignored.
     */
    test('per-call timeout overrides the constructor default', async () => {
        // Constructor default: 5000. Call timeout: 100.
        // deadline = 0 + 100 = 100; currentTime = 101 → timeout
        const clock = clockSequence(0, 101);
        const mgr = new EndpointManager([makeEndpoint()], 5_000, clock, instantSleep);

        await expect(mgr.acquireEndpoint(100, liveSignal())).rejects.toBeInstanceOf(EndpointAcquisitionTimeoutError);
    });
});

describe('endpoint scanning & round-robin', () => {
    test('returns the handle immediately when the first endpoint is available', async () => {
        const handle = { url: 'http://fake', transport: { close: jest.fn() } as any, id: 'first' };
        const ep = makeEndpoint({
            tryAcquire: jest.fn(() => true),
            getHandle: jest.fn(() => handle),
        });
        const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
        const mgr = new EndpointManager([ep], 1000, clockSequence(0), sleep);

        expect(await mgr.acquireEndpoint(1000, liveSignal())).toBe(handle);
        expect(sleep).not.toHaveBeenCalled(); // no waiting at all
    });

    test('iterates past busy endpoints and picks the first available one', async () => {
        const handle = { url: 'http://c', transport: { close: jest.fn() } as any, id: 'C' };
        const epA = makeEndpoint({ tryAcquire: jest.fn(() => false) });
        const epB = makeEndpoint({ tryAcquire: jest.fn(() => false) });
        const epC = makeEndpoint({
            tryAcquire: jest.fn(() => true),
            getHandle: jest.fn(() => handle),
        });
        const mgr = new EndpointManager([epA, epB, epC], 1000, clockSequence(0), instantSleep);

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
        const handles = [
            { url: 'http://a', transport: { close: jest.fn() } as any, id: 'A' },
            { url: 'http://b', transport: { close: jest.fn() } as any, id: 'B' },
            { url: 'http://c', transport: { close: jest.fn() } as any, id: 'C' },
        ];
        const [epA, epB, epC] = handles.map((h) =>
            makeEndpoint({
                tryAcquire: jest.fn(() => false),
                getHandle: jest.fn(() => h),
            }),
        );

        // Call 1: only A (index 0) available → nextIndex becomes 1
        jest.mocked(epA!.tryAcquire).mockReturnValueOnce(true);
        // Call 2: only B (index 1) available — scan starts from 1
        jest.mocked(epB!.tryAcquire).mockReturnValueOnce(true);

        const mgr = new EndpointManager([epA!, epB!, epC!], 10_000, clockSequence(0), instantSleep);

        expect(await mgr.acquireEndpoint(10_000, liveSignal())).toBe(handles[0]); // acquired A

        const r2 = await mgr.acquireEndpoint(10_000, liveSignal());
        expect(r2).toBe(handles[1]); // acquired B — started scan from index 1

        // If nextIndex hadn't advanced, C would be scanned on call 2. It shouldn't be.
        expect(epC!.tryAcquire).not.toHaveBeenCalled();
    });

    /**
     * When the LAST endpoint in the list is acquired, nextIndex must wrap to 0.
     * Without the modulo, nextIndex would go out of bounds or skip index 0 forever.
     */
    test('nextIndex wraps to 0 after acquiring the last endpoint', async () => {
        const handles = [
            { url: 'http://a', transport: { close: jest.fn() } as any, id: 'A' },
            { url: 'http://b', transport: { close: jest.fn() } as any, id: 'B' },
        ];
        const [epA, epB] = handles.map((h) =>
            makeEndpoint({
                tryAcquire: jest.fn(() => false),
                getHandle: jest.fn(() => h),
            }),
        );

        // Call 1: only B (index 1) acquired → nextIndex = (1+1) % 2 = 0
        jest.mocked(epB!.tryAcquire).mockReturnValueOnce(true);

        const mgr = new EndpointManager([epA!, epB!], 10_000, clockSequence(0), instantSleep);
        await mgr.acquireEndpoint(10_000, liveSignal()); // acquires B, wraps nextIndex to 0

        // Call 2: starts from index 0 (A). B must NOT be called if A succeeds.
        jest.mocked(epA!.tryAcquire).mockReturnValueOnce(true);

        const r2 = await mgr.acquireEndpoint(10_000, liveSignal());
        expect(r2).toBe(handles[0]); // A acquired

        // B was called exactly once total (call 1 only) — not on call 2
        expect(epB!.tryAcquire).toHaveBeenCalledTimes(1);
    });

    /**
     * Once an endpoint is acquired, scanning must stop immediately.
     * Endpoints further down the list should not have tryAcquire or timeUntilToken called.
     */
    test('does not scan endpoints after the acquired one in the same iteration', async () => {
        const epA = makeEndpoint({
            tryAcquire: jest.fn(() => true),
            getHandle: jest.fn(() => ({ url: 'http://a', transport: { close: jest.fn() } as any })),
        });
        const epB = makeEndpoint({ tryAcquire: jest.fn(() => true) });

        const mgr = new EndpointManager([epA, epB], 1000, clockSequence(0), instantSleep);
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
            tryAcquire: jest
                .fn(() => false)
                .mockReturnValueOnce(false)
                .mockReturnValue(true),
            getHandle: jest.fn(() => ({ url: 'http://fake', transport: { close: jest.fn() } as any })),
        });
        const clock = jest.fn(() => 0);
        const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
        const mgr = new EndpointManager([ep], 10_000, clock, sleep);

        await mgr.acquireEndpoint(10_000, liveSignal());

        // 1 deadline read + 2 iterations × 1 read = 3 total
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

        // deadline = 1000; iter1 t = 42; iter2 t = 1001 → timeout
        const mgr = new EndpointManager([ep], 1000, clockSequence(0, 42, 1001), instantSleep);
        await mgr.acquireEndpoint(1000, liveSignal()).catch(() => {});

        // Both calls in iteration 1 should have seen 42, not two separate reads
        expect(receivedTimes).toEqual([42, 42]);
    });

    /**
     * Sleep duration must be the MINIMUM across all busy endpoints, not the first
     * or the maximum. Sleeping longer than necessary adds unnecessary latency.
     */
    test('sleeps for the minimum timeUntilToken across all busy endpoints', async () => {
        const epSlow = makeEndpoint({
            tryAcquire: jest.fn(() => false),
            timeUntilToken: jest.fn(() => 300),
        });
        const epFast = makeEndpoint({
            tryAcquire: jest
                .fn(() => false)
                .mockReturnValueOnce(false)
                .mockReturnValue(true),
            timeUntilToken: jest.fn(() => 50),
            getHandle: jest.fn(() => ({ url: 'http://fake', transport: { close: jest.fn() } as any })),
        });
        const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => {});
        const mgr = new EndpointManager([epSlow, epFast], 10_000, clockSequence(0), sleep);

        await mgr.acquireEndpoint(10_000, liveSignal());

        // First iteration: both busy → sleep(min(300, 50)) = sleep(50)
        expect(sleep).toHaveBeenCalledWith(50, expect.anything());
    });
});

describe('close()', () => {
    test('calls close() exactly once on every endpoint', async () => {
        const eps = [makeEndpoint(), makeEndpoint(), makeEndpoint()];
        const mgr = new EndpointManager(eps, 1000, clockSequence(0), instantSleep);

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
        const mgr = new EndpointManager(eps, 1000, clockSequence(0), instantSleep);

        // Don't await yet — just start the operation.
        const closing = mgr.close();

        // All three close() calls must have fired synchronously before any resolved.
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

        const mgr = new EndpointManager([good, bad], 1000, clockSequence(0), instantSleep);

        await expect(mgr.close()).rejects.toThrow('release timeout');
    });
});
