import { stripUserInfo } from './normalization/urlSanitizer.js';

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
    readonly url: string;

    constructor(url: string, message: string, options: TrialErrorOptions = {}) {
        // Userinfo credentials (protocol://user:password@host) are stripped so
        // proxy/API credentials can never leak through err.message, err.url,
        // or logged error context.
        const sanitizedUrl = stripUserInfo(url);

        super(`Invalid API response from ${sanitizedUrl}: ${message}`, options);
        this.url = sanitizedUrl;
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
    readonly endpointAcquireTimeoutMs: number;
    readonly proxyCount: number;

    constructor(endpointAcquireTimeoutMs: number, proxyCount: number) {
        super(
            `Endpoint acquisition timeout: no endpoint available within ${endpointAcquireTimeoutMs}ms (pool size: ${proxyCount})`,
        );
        this.endpointAcquireTimeoutMs = endpointAcquireTimeoutMs;
        this.proxyCount = proxyCount;
    }
}

export class TokenBucketTimeoutError extends TrialError {
    override readonly name = 'TokenBucketTimeoutError';
    readonly rateLimitAcquireTimeoutMs: number;

    constructor(rateLimitAcquireTimeoutMs: number) {
        super(`TokenBucket timeout: no token available within ${rateLimitAcquireTimeoutMs}ms`);
        this.rateLimitAcquireTimeoutMs = rateLimitAcquireTimeoutMs;
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

export class RetryDelayCalculationError extends TrialError {
    override readonly name = 'RetryDelayCalculationError';

    constructor(cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);

        super(`Failed to calculate retry delay: ${message}`, { cause });
    }
}
