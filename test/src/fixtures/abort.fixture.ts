import { jest } from '@jest/globals';

export function createAbortError(): Error {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

export function rejectOnAbort(
    signal: AbortSignal | undefined,
    reject: (reason?: unknown) => void,
    error: unknown,
): void {
    if (!signal) {
        return;
    }

    if (signal.aborted) {
        reject(error);
        return;
    }

    signal.addEventListener('abort', () => reject(error), { once: true });
}

export function createAbortableFetchMock(): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
            const signal = init?.signal as AbortSignal | undefined;

            if (!signal) {
                return;
            }

            rejectOnAbort(signal, reject, createAbortError());
        });
    });
}

export function createAbortableRequestMock(onRequestStarted: () => void): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
            const signal = init?.signal as AbortSignal | undefined;

            if (!signal) {
                throw new Error('Expected fetch signal');
            }

            if (signal.aborted) {
                reject(createAbortError());
                return;
            }

            rejectOnAbort(signal, reject, createAbortError());

            onRequestStarted();
        });
    });
}
