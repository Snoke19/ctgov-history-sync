export interface TrialErrorOptions extends ErrorOptions {
    cause?: unknown;
}

export class TrialError extends Error {
    override name: string = 'TrialError';
    override cause?: unknown;

    constructor(message: string, options: TrialErrorOptions = {}) {
        super(message);

        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}

export class ConfigurationError extends TrialError {
    override name: string = 'ConfigurationError';

    constructor(message: string) {
        super(message);
    }
}

export class TrialNotFoundError extends TrialError {
    override name: string = 'TrialNotFoundError';
    readonly code: string;

    constructor(code: string) {
        super(`Trial not found: ${code}`);
        this.code = code;
    }
}

export class TrialFetchError extends TrialError {
    override name: string = 'TrialFetchError';
    retryAfterMs: number | null = null;
    proxyUrl: string | null = null;
    readonly url: string;
    readonly status: number | null;
    readonly isTransient: boolean;

    constructor(
        url: string,
        cause?: unknown,
        status?: number | null,
        isTransient: boolean = false,
    ) {
        super(`Failed to fetch: ${url}`, { cause });
        this.url = url;
        this.status = status ?? null;
        this.isTransient = isTransient;
    }
}

export interface TrialTimeoutOptions {
    totalBudgetMs?: number | null;
}

export class TrialTimeoutError extends TrialError {
    override name: string = 'TrialTimeoutError';
    readonly url: string;
    readonly timeoutMs: number;
    readonly totalBudgetMs: number | null;
    proxyUrl: string | null = null;

    constructor(
        url: string,
        timeoutMs: number,
        { totalBudgetMs = null }: TrialTimeoutOptions = {},
    ) {
        const budgetNote =
            totalBudgetMs !== null && totalBudgetMs !== timeoutMs
                ? ` (total budget ${totalBudgetMs}ms)`
                : '';
        super(`Fetch timed out after ${timeoutMs}ms${budgetNote}: ${url}`);
        this.url = url;
        this.timeoutMs = timeoutMs;
        this.totalBudgetMs = totalBudgetMs;
    }
}

export class TrialValidationError extends TrialError {
    override name: string = 'TrialValidationError';

    constructor(message: string) {
        super(message);
    }
}

export class TokenBucketTimeoutError extends TrialError {
    override name: string = 'TokenBucketTimeoutError';
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`TokenBucket timeout: no token available within ${timeoutMs}ms`);
        this.timeoutMs = timeoutMs;
    }
}

export interface EndpointAcquisitionOptions {
    budgetExhausted?: boolean;
}

export class EndpointAcquisitionTimeoutError extends TrialError {
    override name: string = 'EndpointAcquisitionTimeoutError';
    readonly timeoutMs: number;
    readonly proxyCount: number;
    readonly budgetExhausted: boolean;

    constructor(
        timeoutMs: number,
        proxyCount: number,
        { budgetExhausted = false }: EndpointAcquisitionOptions = {},
    ) {
        const message = budgetExhausted
            ? `Proxy acquisition consumed the full ${timeoutMs}ms budget before fetch could start (pool size: ${proxyCount})`
            : `Proxy acquisition timeout: no proxy available within ${timeoutMs}ms (pool size: ${proxyCount})`;
        super(message);
        this.timeoutMs = timeoutMs;
        this.proxyCount = proxyCount;
        this.budgetExhausted = budgetExhausted;
    }
}
