export class TrialError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'TrialError';

        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}

export class TrialNotFoundError extends TrialError {
    constructor(code) {
        super(`Trial not found: ${code}`);
        this.name = 'TrialNotFoundError';
        this.code = code;
    }
}

export class TrialFetchError extends TrialError {
    /**
     * @type {number|null}
     */
    retryAfterMs = null;

    /**
     * @type {string|null}
     */
    proxyUrl = null;

    constructor(url, cause, status, isTransient = false) {
        super(`Failed to fetch: ${url}`, {cause});
        this.name = 'TrialFetchError';
        this.url = url;
        this.status = status ?? null;
        this.isTransient = isTransient;
    }
}

export class TrialTimeoutError extends TrialError {
    /**
     * @param {string} url
     * @param {number} timeoutMs - Time budget for the phase that timed out (fetch).
     * @param {{ totalBudgetMs?: number|null }} [options]
     */
    constructor(url, timeoutMs, {totalBudgetMs = null} = {}) {
        const budgetNote =
            totalBudgetMs !== null && totalBudgetMs !== timeoutMs
                ? ` (total budget ${totalBudgetMs}ms)`
                : '';
        super(`Fetch timed out after ${timeoutMs}ms${budgetNote}: ${url}`);
        this.name = 'TrialTimeoutError';
        this.url = url;
        this.timeoutMs = timeoutMs;
        this.totalBudgetMs = totalBudgetMs;
    }
}

export class TrialValidationError extends TrialError {
    constructor(message) {
        super(message);
        this.name = 'TrialValidationError';
    }
}

export class TokenBucketTimeoutError extends TrialError {
    constructor(timeoutMs) {
        super(`TokenBucket timeout: no token available within ${timeoutMs}ms`);
        this.name = 'TokenBucketTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

export class EndpointAcquisitionTimeoutError extends TrialError {
    /**
     * @param {number} timeoutMs
     * @param {number} proxyCount
     * @param {{ budgetExhausted?: boolean }} [options]
     */
    constructor(timeoutMs, proxyCount, {budgetExhausted = false} = {}) {
        const message = budgetExhausted
            ? `Proxy acquisition consumed the full ${timeoutMs}ms budget before fetch could start (pool size: ${proxyCount})`
            : `Proxy acquisition timeout: no proxy available within ${timeoutMs}ms (pool size: ${proxyCount})`;
        super(message);
        this.name = 'EndpointAcquisitionTimeoutError';
        this.timeoutMs = timeoutMs;
        this.proxyCount = proxyCount;
        this.budgetExhausted = budgetExhausted;
    }
}
