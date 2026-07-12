export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getJitteredDelay(attempt, baseMs, maxMs) {
    const cap = Math.min(baseMs * (2 ** (attempt - 1)), maxMs);
    return Math.random() * cap;
}

export async function withRetry(operation, options = {}) {
    const {
        attempts = 3,
        baseDelayMs = 1_000,
        maxDelayMs = 60_000,
        shouldRetry = () => true,
        getRequestedDelay = () => null,
        onRetry = () => {},
    } = options;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation(attempt);
        } catch (error) {
            if (attempt === attempts || !shouldRetry(error)) {
                throw error;
            }

            const requestedMs = getRequestedDelay(error);
            const waitMs = requestedMs != null ? requestedMs : getJitteredDelay(attempt, baseDelayMs, maxDelayMs);
            onRetry(attempt, attempts, waitMs, error);
            await sleep(waitMs);
        }
    }
}
