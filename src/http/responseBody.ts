import {logger} from '../config/logging.js';
import {TrialFetchError} from '../error/errors.js';
import {Response} from "undici";

interface ParseJsonResponseOptions {
    allow404?: boolean;
    errorBodyPreviewLength: number;
    retryableStatusCodes: ReadonlySet<number>;
}

export async function drainBody(response: Response): Promise<void> {
    if (!response?.body) {
        return;
    }

    try {
        await response.body.cancel();
    } catch {
        // Already closed or errored - safe to ignore.
    }
}

export async function parseJsonResponse(response: Response,
                                        url: string,
                                        options: ParseJsonResponseOptions) {
    const {allow404 = false, errorBodyPreviewLength, retryableStatusCodes} = options;

    if (!retryableStatusCodes) {
        throw new TypeError('parseJsonResponse: retryableStatusCodes is required');
    }

    if (response.status === 404) {
        logger.debug('HTTP 404 on %s | allow404=%s', url, allow404);
    }

    if (allow404 && response.status === 404) {
        await drainBody(response);
        return null;
    }

    if (response.status === 204) {
        await drainBody(response);
        return null;
    }

    if (!response.ok) {
        const text = await readErrorPreview(
            response,
            errorBodyPreviewLength,
        ).catch((error) => {
            logger.debug(
                'Failed to read error preview: %s',
                error.message,
            );
            return '';
        });

        throw new TrialFetchError(
            url,
            new Error(
                `HTTP ${response.status}: ${response.statusText}. ` +
                `Body: ${text}`,
            ),
            response.status,
            retryableStatusCodes.has(response.status),
        );
    }

    const contentType = response.headers.get('Content-Type') ?? '';

    if (!contentType.includes('application/json')) {
        logger.warn('Unexpected Content-Type: %s | %s', contentType, url);
    }

    try {
        return await response.json();
    } catch (error: any) {
        await drainBody(response);

        throw new TrialFetchError(
            url,
            new Error(`Invalid JSON: ${error.message}`),
            response.status,
            false,
        );
    }
}

async function readErrorPreview(response: Response, maxBytes: number) {
    if (!response.body || maxBytes <= 0) {
        return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let preview = '';
    let bytesRead = 0;

    try {
        while (bytesRead < maxBytes) {
            const {done, value} = await reader.read();

            if (done) {
                break;
            }

            const remaining = maxBytes - bytesRead;
            const chunk = value.subarray(0, remaining);

            preview += decoder.decode(chunk, {
                stream: true,
            });

            bytesRead += chunk.length;
        }

        preview += decoder.decode();
    } finally {
        try {
            await reader.cancel();
        } catch {
            // Ignore cancellation errors.
        }

        reader.releaseLock();
    }

    return preview;
}