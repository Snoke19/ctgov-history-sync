export interface TrialErrorOptions extends ErrorOptions {
    readonly context?: Record<string, unknown> | undefined;
}

/**
 * Root of the application's error hierarchy.
 *
 * Invariant:
 * Every error that crosses an application/infrastructure boundary
 * should be a TrialError.
 */
export class TrialError extends Error {
    override readonly name: string = 'TrialError';
    readonly context?: Readonly<Record<string, unknown>> | undefined;

    constructor(message: string, options: TrialErrorOptions = {}) {
        super(message, options);

        this.context = options.context;
        Object.setPrototypeOf(this, new.target.prototype);
    }

    static normalize(error: unknown): TrialError {
        if (error instanceof TrialError) {
            return error;
        }

        return new UnexpectedError(error);
    }
}

export class UnexpectedError extends TrialError {
    override readonly name = 'UnexpectedError';

    constructor(cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);

        super(`Unexpected error: ${message}`, { cause });
    }
}

export class ConfigurationError extends TrialError {
    override readonly name = 'ConfigurationError';

    constructor(message: string, options: TrialErrorOptions = {}) {
        super(message, options);
    }
}

export class TrialValidationError extends TrialError {
    override readonly name = 'TrialValidationError';

    constructor(message: string) {
        super(message);
    }
}

export class ApiResponseValidationError extends TrialError {
    override readonly name = 'ApiResponseValidationError';

    constructor(
        readonly url: string,
        message: string,
        options: TrialErrorOptions = {},
    ) {
        super(`Invalid API response from ${url}: ${message}`, options);
    }
}

export class TrialNotFoundError extends TrialError {
    override readonly name = 'TrialNotFoundError';

    constructor(readonly code: string) {
        super(`Trial not found: ${code}`);
    }
}

export class HttpException extends TrialError {
    override readonly name = 'HttpException';

    constructor(
        message: string,
        readonly status: number,
        readonly retryAfterMs?: number,
        options: TrialErrorOptions = {},
    ) {
        super(message, options);
    }
}

export class NetworkException extends TrialError {
    override readonly name = 'NetworkException';

    constructor(message: string, options: TrialErrorOptions = {}) {
        super(message, options);
    }
}

export class TimeoutException extends TrialError {
    override readonly name = 'TimeoutException';

    constructor(message: string, options: TrialErrorOptions = {}) {
        super(message, options);
    }
}

export class CallerAbortedError extends TrialError {
    override readonly name = 'CallerAbortedError';

    constructor(message = 'The operation was aborted.', options: TrialErrorOptions = {}) {
        super(message, options);
    }
}

export class EndpointAcquisitionTimeoutError extends TrialError {
    override readonly name = 'EndpointAcquisitionTimeoutError';
    readonly timeoutMs: number;
    readonly proxyCount: number;

    constructor(timeoutMs: number, proxyCount: number) {
        super(`Endpoint acquisition timeout: no endpoint available within ${timeoutMs}ms (pool size: ${proxyCount})`);
        this.timeoutMs = timeoutMs;
        this.proxyCount = proxyCount;
    }
}

export class TokenBucketTimeoutError extends TrialError {
    override readonly name = 'TokenBucketTimeoutError';
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`TokenBucket timeout: no token available within ${timeoutMs}ms`);
        this.timeoutMs = timeoutMs;
    }
}

export class EndpointAssemblyError extends TrialError {
    override readonly name = 'EndpointAssemblyError';

    constructor(
        message: string,
        options: TrialErrorOptions = {},
        readonly cleanupErrors: readonly unknown[] = [],
    ) {
        super(message, options);
    }
}
