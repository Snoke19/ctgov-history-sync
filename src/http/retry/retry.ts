import { BusinessException } from './businessException.js';
import { BusinessOperation } from './businessOperation.js';

export class Retry<T> implements BusinessOperation<T> {
    private readonly op: BusinessOperation<T>;
    private readonly maxRetries: number;
    private readonly shouldRetry: (error: BusinessException) => boolean;
    private readonly delayMs: number | ((attempt: number, error: BusinessException) => number);
    private readonly sleep: (ms: number) => Promise<void>;
    private attemptsCount = 0;

    /**
     * @param op          The operation to execute, retried on failure.
     * @param maxRetries  Number of retries after the initial attempt.
     * @param shouldRetry  Decides whether a failed attempt warrants another try.
     * @param delayMs     Fixed delay between attempts, or a function of the
     *                    zero-indexed retry attempt and the last error.
     * @param sleep       Async delay implementation. Defaults to `setTimeout`.
     */
    constructor(
        op: BusinessOperation<T>,
        maxRetries: number,
        shouldRetry: (error: BusinessException) => boolean,
        delayMs: number | ((attempt: number, error: BusinessException) => number),
        sleep: (ms: number) => Promise<void> = (ms) =>
            new Promise((resolve) => {
                setTimeout(resolve, ms);
            }),
    ) {
        this.op = op;
        this.maxRetries = maxRetries;
        this.shouldRetry = shouldRetry;
        this.delayMs = delayMs;
        this.sleep = sleep;
    }

    async perform(): Promise<T> {
        while (this.attemptsCount < this.maxRetries) {
            try {
                return await this.op.perform();
            } catch (e) {
                if (!(e instanceof BusinessException)) {
                    throw e;
                }

                const error = e as BusinessException;

                if (!this.shouldRetry(error)) {
                    throw error;
                }

                this.attemptsCount++;

                const delay =
                    typeof this.delayMs === 'function' ? this.delayMs(this.attemptsCount - 1, error) : this.delayMs;

                await this.sleep(Math.max(0, delay));
            }
        }

        return await this.op.perform();
    }
}
