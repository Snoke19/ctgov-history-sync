import { expect } from '@jest/globals';

export async function expectRejected<T extends Error>(
    promise: Promise<unknown>,
    errorClass: new (...args: never[]) => T,
): Promise<T> {
    const error = await promise.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(errorClass);
    return error as T;
}
