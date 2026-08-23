import { jest } from '@jest/globals';

export function createAbortError(): DOMException {
    return new DOMException('The operation was aborted.', 'AbortError');
}

export function createAbortableFetchMock(): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
            const signal = init?.signal as AbortSignal | undefined;

            if (!signal) {
                return;
            }

            const onAbort = (): void => {
                reject(createAbortError());
            };

            if (signal.aborted) {
                onAbort();
                return;
            }

            signal.addEventListener('abort', onAbort, { once: true });
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

            const onAbort = (): void => {
                reject(createAbortError());
            };

            if (signal.aborted) {
                onAbort();
                return;
            }

            signal.addEventListener('abort', onAbort, { once: true });

            onRequestStarted();
        });
    });
}
