import { BusinessException } from './businessException.js';

export class HttpException extends BusinessException {
    constructor(
        message: string,
        readonly status: number,
        readonly retryAfterMs?: number,
    ) {
        super(message);
    }
}

export class NetworkException extends BusinessException {
    constructor(
        message: string,
        override readonly cause?: unknown,
    ) {
        super(message);
    }
}

export class TimeoutException extends BusinessException {
    constructor(message: string) {
        super(message);
    }
}
