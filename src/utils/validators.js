import {TrialValidationError} from '../error/errors.js';

const nctIdPattern = /^NCT\d{8}$/i;
const geoPattern = /^distance\(-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?(km|mi)?\)$/;
const decayPattern =
    /^func:(gauss|exp|linear),scale:(\d+(\.\d+)?(km|mi)),offset:(\d+(\.\d+)?(km|mi)),decay:(\d+(\.\d+)?)$/;

/**
 * Validates that `value` is a correctly formatted NCT identifier.
 *
 * @param {string} value - Expected format: "NCT" followed by exactly 8 digits,
 *   case-insensitive (e.g. "NCT12345678").
 * @throws {TrialValidationError}
 */
export function validateNctId(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TrialValidationError('nctId must be a non-empty string');
    }

    if (!nctIdPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid nctId format. Expected: NCT followed by 8 digits. Got: "${value}"`,
        );
    }
}

/**
 * Validates the `filter.geo` / `postFilter.geo` distance filter string.
 *
 * @param {string} value - Expected format: `distance(lat,lon,dist[km|mi])`.
 * @param {string} [paramName='filter.geo'] - Parameter name used in the error message.
 * @throws {TrialValidationError}
 */
export function validateGeoFilter(value, paramName = 'filter.geo') {
    if (typeof value !== 'string' || !geoPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid ${paramName} format. Expected: distance(lat,lon,dist)[km|mi]. Got: "${value}"`,
        );
    }
}

/**
 * Validates the geo-decay scoring function string.
 *
 * @param {string} value - Expected format:
 *   `func:(gauss|exp|linear),scale:<dist>,offset:<dist>,decay:<number>`.
 * @throws {TrialValidationError}
 */
export function validateGeoDecay(value) {
    if (typeof value !== 'string') {
        throw new TrialValidationError('geoDecay must be a string');
    }

    if (!decayPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid geoDecay format. Expected: func:(gauss|exp|linear),scale:<dist><km|mi>,offset:<dist><km|mi>,decay:<number>. Got: "${value}"`,
        );
    }
}

/**
 * Validates that `value` is a positive integer suitable for use as a page size.
 *
 * @param {number} value
 * @throws {TrialValidationError}
 */
export function validatePageSize(value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new TrialValidationError('pageSize must be a positive integer');
    }
}

/**
 * Validates an already-cleaned params object used in search requests.
 * Checks `pageSize`, `filter.geo`, `postFilter.geo`, and `geoDecay` when present.
 *
 * @param {object} params - Cleaned params (output of `cleanParams`).
 * @throws {TrialValidationError} On any invalid field value.
 */
export function validateSearchParams(params) {
    if ('pageSize' in params) {
        validatePageSize(params.pageSize);
    }

    if ('filter.geo' in params) {
        validateGeoFilter(params['filter.geo'], 'filter.geo');
    }

    if ('postFilter.geo' in params) {
        validateGeoFilter(params['postFilter.geo'], 'postFilter.geo');
    }

    if ('geoDecay' in params) {
        validateGeoDecay(params.geoDecay);
    }
}
