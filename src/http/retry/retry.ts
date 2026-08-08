import { BusinessException } from './businessException.js';
import { BusinessOperation } from './businessOperation.js';

export class Retry<T> implements BusinessOperation<T> {
    private readonly op: BusinessOperation<T>;
    private readonly maxAttempts: number;
    private readonly delayMs: number | ((attempt: number, error: BusinessException) => number);
    private attemptsCount: number;
    private readonly shouldRetry: (error: BusinessException) => boolean;
    private readonly errors: BusinessException[];

    constructor(
        op: BusinessOperation<T>,
        maxAttempts: number,
        delayMs: number | ((attempt: number, error: BusinessException) => number),
        ...ignoreTests: Array<(error: BusinessException) => boolean>
    ) {
        this.op = op;
        this.maxAttempts = maxAttempts;
        this.delayMs = delayMs;
        this.attemptsCount = 0;
        this.shouldRetry = ignoreTests.length > 0 ? (e) => ignoreTests.some((test) => test(e)) : () => false;
        this.errors = [];
    }

    public getErrors(): readonly BusinessException[] {
        return Object.freeze([...this.errors]);
    }

    attempts(): number {
        return this.attemptsCount;
    }

    async perform(): Promise<T> {
        do {
            try {
                return await this.op.perform();
            } catch (e) {
                if (!(e instanceof BusinessException)) {
                    throw e;
                }

                const error = e as BusinessException;
                this.errors.push(error);

                if (++this.attemptsCount >= this.maxAttempts || !this.shouldRetry(error)) {
                    throw error;
                }

                const delay =
                    typeof this.delayMs === 'function' ? this.delayMs(this.attemptsCount - 1, error) : this.delayMs;

                await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
            }
        } while (true);
    }
}
