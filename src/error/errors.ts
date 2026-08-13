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

export class EndpointAcquisitionTimeoutError extends TrialError {
    override name: string = 'EndpointAcquisitionTimeoutError';
    readonly timeoutMs: number;
    readonly proxyCount: number;

    constructor(timeoutMs: number, proxyCount: number) {
        super(`Proxy acquisition timeout: no proxy available within ${timeoutMs}ms (pool size: ${proxyCount})`);
        this.timeoutMs = timeoutMs;
        this.proxyCount = proxyCount;
    }
}

export class CallerAbortedError extends Error {
    constructor(message = 'The operation was aborted.') {
        super(message);
        this.name = 'CallerAbortedError';
    }
}

export class ApiResponseValidationError extends TrialError {
    override name = 'ApiResponseValidationError';

    constructor(
        readonly url: string,
        message: string,
        cause?: unknown,
    ) {
        super(`Invalid API response from ${url}: ${message}`, { cause });
    }
}
