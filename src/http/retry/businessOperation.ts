export interface BusinessOperation<T> {
    /**
     * Performs a business operation.
     *
     * @returns The result of the operation.
     * @throws {TrialError} If the operation fails.
     * Implementations may throw more specific subclasses depending on
     * the error conditions.
     */
    perform(): Promise<T>;
}
