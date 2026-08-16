import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Logging context attached to every log record created while the context is
 * active. The context is propagated automatically through the async call
 * chain by Node.js AsyncLocalStorage, so no Logger instances need to be
 * passed through constructors.
 */
export interface LogContext {
    readonly correlationId: string;
    readonly requestId?: string;
    readonly operation?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Runs `run` inside a new logging context. The context (and any context
 * created inside `run`) is visible to every log call made by the current
 * async call chain, including awaited continuations and concurrent siblings.
 */
export function withLogContext<T>(context: LogContext, run: () => T): T {
    return asyncLocalStorage.run(context, run);
}

/** Returns the logging context of the current async call chain, if any. */
export function getLogContext(): LogContext | undefined {
    return asyncLocalStorage.getStore();
}
