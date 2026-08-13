import { ConfigurationError } from '../error/errors.js';
import { assertNonNegativeInt, assertPositiveInt } from '../utils/validation.js';
import { FetchJsonRequestOptions } from './types/http.js';

export function validateFetchJsonRequestOptions(options: FetchJsonRequestOptions): void {
    if (options.timeoutMs !== undefined) {
        assertPositiveInt(options.timeoutMs, 'timeoutMs');
    }

    if (options.maxRetries !== undefined) {
        assertNonNegativeInt(options.maxRetries, 'maxRetries');
    }

    const policy = options.retryPolicy;

    if (!policy) {
        return;
    }

    if (policy.retryOnTimeout !== undefined && typeof policy.retryOnTimeout !== 'boolean') {
        throw new ConfigurationError('retryPolicy.retryOnTimeout must be a boolean');
    }

    if (policy.retryOnNetworkError !== undefined && typeof policy.retryOnNetworkError !== 'boolean') {
        throw new ConfigurationError('retryPolicy.retryOnNetworkError must be a boolean');
    }

    if (policy.baseDelayMs !== undefined) {
        assertPositiveInt(policy.baseDelayMs, 'retryPolicy.baseDelayMs');
    }

    if (policy.backoffCapMs !== undefined) {
        assertPositiveInt(policy.backoffCapMs, 'retryPolicy.backoffCapMs');
    }

    if (policy.retryableStatusCodes !== undefined) {
        for (const status of policy.retryableStatusCodes) {
            if (!Number.isInteger(status) || status < 100 || status > 599) {
                throw new ConfigurationError(`retryPolicy.retryableStatusCodes contains invalid status: ${status}`);
            }
        }
    }
}
