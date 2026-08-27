import { TrialValidationError } from '../error/errors.js';
import { makeAssertions } from '../utils/assertions.js';
import type { FetchJsonRequestOptions } from './http.js';

const requestAssert = makeAssertions(TrialValidationError);

export function validateFetchJsonRequestOptions(options: FetchJsonRequestOptions): void {
    if (options.requestAbortTimeoutMs !== undefined) {
        requestAssert.assertInteger(options.requestAbortTimeoutMs, 'requestAbortTimeoutMs', {
            min: 1,
            label: 'a positive integer',
        });
    }

    if (options.maxRetries !== undefined) {
        requestAssert.assertInteger(options.maxRetries, 'maxRetries', {
            min: 0,
        });
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
        requestAssert.assertInteger(policy.baseDelayMs, 'retryPolicy.baseDelayMs', {
            min: 1,
            label: 'a positive integer',
        });
    }

    if (policy.backoffCapMs !== undefined) {
        requestAssert.assertInteger(policy.backoffCapMs, 'retryPolicy.backoffCapMs', {
            min: 1,
            label: 'a positive integer',
        });
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
