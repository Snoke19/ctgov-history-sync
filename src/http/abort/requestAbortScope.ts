export const ABORT_REASON_CALLER = 'caller' as const;
export const ABORT_REASON_TIMEOUT = 'timeout' as const;

export type AbortReason = typeof ABORT_REASON_CALLER | typeof ABORT_REASON_TIMEOUT;

export class RequestAbortScope {
    private readonly controller = new AbortController();
    private requestAbortTimeoutId: ReturnType<typeof setTimeout> | undefined;
    private readonly callerAbortSignal: AbortSignal | undefined;
    private readonly requestAbortTimeoutMs: number;
    private readonly onCallerAbort = (): void => {
        this.controller.abort(ABORT_REASON_CALLER);
    };

    constructor(options: {
        readonly callerAbortSignal?: AbortSignal | undefined;
        readonly requestAbortTimeoutMs: number;
    }) {
        this.callerAbortSignal = options.callerAbortSignal;
        this.requestAbortTimeoutMs = options.requestAbortTimeoutMs;

        if (options.callerAbortSignal) {
            if (options.callerAbortSignal.aborted) {
                this.controller.abort(ABORT_REASON_CALLER);
            } else {
                options.callerAbortSignal.addEventListener('abort', this.onCallerAbort, { once: true });
            }
        }
    }

    get requestAbortSignal(): AbortSignal {
        return this.controller.signal;
    }

    startRequestAbortTimeout(): void {
        if (this.requestAbortTimeoutId !== undefined || this.controller.signal.aborted) {
            return;
        }

        this.requestAbortTimeoutId = setTimeout(() => {
            this.controller.abort(ABORT_REASON_TIMEOUT);
        }, this.requestAbortTimeoutMs);
    }

    dispose(): void {
        if (this.requestAbortTimeoutId !== undefined) {
            clearTimeout(this.requestAbortTimeoutId);
        }
        this.callerAbortSignal?.removeEventListener('abort', this.onCallerAbort);
    }
}

export async function withRequestAbort<T>(
    options: { readonly callerAbortSignal?: AbortSignal | undefined; readonly requestAbortTimeoutMs: number },
    fn: (requestAbortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
    const scope = new RequestAbortScope(options);
    scope.startRequestAbortTimeout();

    try {
        return await fn(scope.requestAbortSignal);
    } finally {
        scope.dispose();
    }
}
