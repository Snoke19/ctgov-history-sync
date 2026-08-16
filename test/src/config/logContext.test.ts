import { describe, expect, it } from '@jest/globals';
import { getLogContext, LogContext, withLogContext } from '../../../src/config/logContext.js';

describe('logContext', () => {
    it('returns undefined outside of any context', () => {
        expect(getLogContext()).toBeUndefined();
    });

    it('propagates the context through awaited continuations', async () => {
        const seen = await withLogContext({ correlationId: 'corr-1' }, async () => {
            await Promise.resolve();
            const inner = getLogContext();
            await Promise.resolve();
            return inner;
        });

        expect(seen).toEqual({ correlationId: 'corr-1' });
    });

    it('returns the result of the wrapped run', async () => {
        const result = await withLogContext({ correlationId: 'corr-1' }, async () => 'done');

        expect(result).toBe('done');
    });

    it('restores the previous context after the wrapped run finishes', async () => {
        await withLogContext({ correlationId: 'outer' }, async () => {
            expect(getLogContext()).toEqual({ correlationId: 'outer' });
        });

        expect(getLogContext()).toBeUndefined();
    });

    it('propagates requestId inside a correlationId context', async () => {
        const seen: Array<LogContext | undefined> = [];

        await withLogContext({ correlationId: 'corr-1' }, async () => {
            await withLogContext({ correlationId: 'corr-1', requestId: 'req-1' }, async () => {
                seen.push(getLogContext());
            });

            seen.push(getLogContext());
        });

        expect(seen[0]).toEqual({ correlationId: 'corr-1', requestId: 'req-1' });
        expect(seen[1]).toEqual({ correlationId: 'corr-1' });
    });

    it('isolates concurrent contexts (AsyncLocalStorage correctness)', async () => {
        const results = await Promise.all([
            withLogContext({ correlationId: 'corr-a', requestId: 'req-a' }, async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 10);
                });
                return getLogContext();
            }),
            withLogContext({ correlationId: 'corr-b', requestId: 'req-b' }, async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 1);
                });
                return getLogContext();
            }),
        ]);

        expect(results[0]).toEqual({ correlationId: 'corr-a', requestId: 'req-a' });
        expect(results[1]).toEqual({ correlationId: 'corr-b', requestId: 'req-b' });
    });

    it('propagates the context through Promise.all workers', async () => {
        const results = await withLogContext({ correlationId: 'corr-parallel' }, async () => {
            const values = await Promise.all([
                Promise.resolve('a').then(() => getLogContext()),
                Promise.resolve('b').then(() => getLogContext()),
            ]);

            return values;
        });

        expect(results[0]).toEqual({ correlationId: 'corr-parallel' });
        expect(results[1]).toEqual({ correlationId: 'corr-parallel' });
    });
});
