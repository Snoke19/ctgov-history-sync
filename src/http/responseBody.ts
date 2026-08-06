import { logger } from '../config/logging.js';
import { TrialFetchError } from '../error/errors.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';

interface ParseJsonResponseOptions {
    allow404?: boolean;
    errorBodyPreviewLength: number;
    retryableStatusCodes: ReadonlySet<number>;
}

export async function drainBody(response: HttpResponse): Promise<void> {
    if (!response?.json) {
        return;
    }

    try {
        await response.discard();
    } catch {
        // Already closed or errored - safe to ignore.
    }
}

export async function parseJsonResponse(
    response: HttpResponse,
    url: string,
    options: ParseJsonResponseOptions,
) {
    const { allow404 = false, errorBodyPreviewLength, retryableStatusCodes } = options;

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
        const text = await readErrorPreview(response, errorBodyPreviewLength).catch((error) => {
            logger.debug('Failed to read error preview: %s', error.message);
            return '';
        });

        throw new TrialFetchError(
            url,
            new Error(`HTTP ${response.status}: ${response.statusText}. ` + `Body: ${text}`),
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

async function readErrorPreview(response: HttpResponse, maxBytes: number) {
    if (maxBytes <= 0) {
        return '';
    }

    try {
        const text = await response.text();
        return text.slice(0, maxBytes);
    } catch {
        return '';
    }
}
