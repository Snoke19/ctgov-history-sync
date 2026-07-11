export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculates exponential backoff with full jitter.
 */
function getJitteredDelay(attempt, baseMs, maxMs) {
    const exponentialWait = baseMs * (2 ** (attempt - 1));
    const cappedWait = Math.min(exponentialWait, maxMs);

    return (cappedWait / 2) + (Math.random() * (cappedWait / 2));
}

export async function withRetry(operation, options = {}) {
    const {
        attempts = 3,
        baseDelayMs = 1000,
        maxDelayMs = 30000,
        shouldRetry = () => true,
        getRequestedDelay = () => null,
        onRetry = () => {
        }
    } = options;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation(attempt);
        } catch (error) {
            if (attempt === attempts || !shouldRetry(error)) {
                throw error;
            }

            const requestedDelayMs = getRequestedDelay(error);

            const waitMs = requestedDelayMs || getJitteredDelay(attempt, baseDelayMs, maxDelayMs);

            onRetry(attempt, attempts, waitMs, error);
            await sleep(waitMs);
        }
    }
}
