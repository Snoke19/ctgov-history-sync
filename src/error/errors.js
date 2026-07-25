export class TrialNotFoundError extends Error {
    constructor(code) {
        super(`Trial not found: ${code}`);
        this.name = 'TrialNotFoundError';
        this.code = code;
    }
}

export class TrialFetchError extends Error {
    /**
     * @type {number|null}
     */
    retryAfterMs = null;

    /**
     * @type {string|null}
     */
    proxyUrl = null;

    constructor(url, cause, status, isTransient = false) {
        super(`Failed to fetch: ${url}`);
        this.name = 'TrialFetchError';
        this.url = url;
        this.cause = cause;
        this.status = status ?? null;
        this.isTransient = isTransient;
    }
}

export class TrialTimeoutError extends Error {
    constructor(url, timeoutMs) {
        super(`Request timed out after ${timeoutMs}ms: ${url}`);
        this.name = 'TrialTimeoutError';
        this.url = url;
        this.timeoutMs = timeoutMs;
    }
}

export class TrialValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TrialValidationError';
    }
}

export class TokenBucketTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`TokenBucket timeout: no token available within ${timeoutMs}ms`);
        this.name = 'TokenBucketTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

export class EndpointAcquisitionTimeoutError extends Error {
    constructor(timeoutMs, proxyCount) {
        super(
            `Proxy acquisition timeout: no proxy available within ${timeoutMs}ms (pool size: ${proxyCount})`,
        );
        this.name = 'EndpointAcquisitionTimeoutError';
        this.timeoutMs = timeoutMs;
        this.proxyCount = proxyCount;
    }
}
