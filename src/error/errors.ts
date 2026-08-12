export interface TrialErrorOptions extends ErrorOptions {
    cause?: unknown;
}

export class TrialError extends Error {
    override name: string = 'TrialError';
    override cause?: unknown;

    constructor(message: string, options: TrialErrorOptions = {}) {
        // Use native Error cause when available so stack traces and tools
        // see the underlying error consistently.
        // Node's Error constructor accepts an options object { cause }.
        // Call super with the cause when present and also set this.cause
        // for environments that may not surface it automatically.
        if (options.cause !== undefined) {
            // @ts-expect-error - some TS lib targets may not include the second arg overload
            super(message, { cause: options.cause });
            this.cause = options.cause;
        } else {
            super(message);
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
    readonly url: string;
    readonly status: number | null;
    readonly isTransient: boolean;

    constructor(url: string, cause?: unknown, status?: number | null, isTransient: boolean = false) {
        super(`Failed to fetch: ${url}`, { cause });
        this.url = url;
        this.status = status ?? null;
        this.isTransient = isTransient;
    }
}

export class HttpException extends TrialError {
    override name: string = 'HttpException';

    constructor(
        message: string,
        readonly status: number,
        readonly retryAfterMs?: number,
    ) {
        super(message);
    }
}

export class NetworkException extends TrialError {
    override name: string = 'NetworkException';

    constructor(message: string, cause?: unknown) {
        super(message, { cause });
    }
}

export class TimeoutException extends TrialError {
    override name: string = 'TimeoutException';

    constructor(message: string) {
        super(message);
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

    constructor(timeoutMs: number, proxyCount: number, { budgetExhausted = false }: EndpointAcquisitionOptions = {}) {
        const message = budgetExhausted
            ? `Proxy acquisition consumed the full ${timeoutMs}ms budget before fetch could start (pool size: ${proxyCount})`
            : `Proxy acquisition timeout: no proxy available within ${timeoutMs}ms (pool size: ${proxyCount})`;
        super(message);
        this.timeoutMs = timeoutMs;
        this.proxyCount = proxyCount;
        this.budgetExhausted = budgetExhausted;
    }
}

export class CallerAbortedError extends Error {
    constructor(message = 'The operation was aborted.') {
        super(message);
        this.name = 'CallerAbortedError';
    }
}
