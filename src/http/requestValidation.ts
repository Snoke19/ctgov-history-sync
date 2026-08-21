import { TrialValidationError } from '../error/errors.js';
import { assertTrialNonNegativeInt, assertTrialPositiveInt } from '../utils/validation.js';
import type { FetchJsonRequestOptions } from './http.js';

export function validateFetchJsonRequestOptions(options: FetchJsonRequestOptions): void {
    if (options.timeoutMs !== undefined) {
        assertTrialPositiveInt(options.timeoutMs, 'timeoutMs');
    }

    if (options.maxRetries !== undefined) {
        assertTrialNonNegativeInt(options.maxRetries, 'maxRetries');
    }

    const policy = options.retryPolicy;

    if (!policy) {
        return;
    }

    if (policy.retryOnTimeout !== undefined && typeof policy.retryOnTimeout !== 'boolean') {
        throw new TrialValidationError('retryPolicy.retryOnTimeout must be a boolean');
    }

    if (policy.retryOnNetworkError !== undefined && typeof policy.retryOnNetworkError !== 'boolean') {
        throw new TrialValidationError('retryPolicy.retryOnNetworkError must be a boolean');
    }

    if (policy.baseDelayMs !== undefined) {
        assertTrialPositiveInt(policy.baseDelayMs, 'retryPolicy.baseDelayMs');
    }

    if (policy.backoffCapMs !== undefined) {
        assertTrialPositiveInt(policy.backoffCapMs, 'retryPolicy.backoffCapMs');
    }

    if (policy.retryableStatusCodes !== undefined) {
        if (policy.retryableStatusCodes.has(404)) {
            throw new TrialValidationError('retryPolicy.retryableStatusCodes must not contain 404');
        }

        for (const status of policy.retryableStatusCodes) {
            if (!Number.isInteger(status) || status < 100 || status > 599) {
                throw new TrialValidationError(`retryPolicy.retryableStatusCodes contains invalid status: ${status}`);
            }
        }
    }
}
