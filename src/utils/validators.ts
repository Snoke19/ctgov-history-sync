import {TrialValidationError} from '../error/errors.js';

const nctIdPattern = /^NCT\d{8}$/i;
const geoPattern = /^distance\(-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?(km|mi)?\)$/;
const decayPattern = /^func:(gauss|exp|linear),scale:(\d+(\.\d+)?(km|mi)),offset:(\d+(\.\d+)?(km|mi)),decay:(\d+(\.\d+)?)$/;

export function validateNctId(value: string) {
    if (value === null || value.trim() === '') {
        throw new TrialValidationError('nctId must be a non-empty string');
    }

    if (!nctIdPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid nctId format. Expected: NCT followed by 8 digits. Got: "${value}"`,
        );
    }
}

export function validateGeoFilter(value: string, paramName = 'filter.geo') {
    if (typeof value !== 'string' || !geoPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid ${paramName} format. Expected: distance(lat,lon,dist)[km|mi]. Got: "${value}"`,
        );
    }
}

export function validateGeoDecay(value: string): void {

    if (value === undefined || value === null || !decayPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid geoDecay format. Expected: func:(gauss|exp|linear),scale:<dist><km|mi>,offset:<dist><km|mi>,decay:<number>. Got: "${value}"`,
        );
    }
}

export function validatePageSize(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
        throw new TrialValidationError('pageSize must be a positive integer');
    }
}

export interface SearchParams {
    pageSize?: number;
    'filter.geo'?: string;
    'postFilter.geo'?: string;
    geoDecay?: string;

    [key: string]: unknown;
}

export function validateSearchParams(params: SearchParams) {
    if (params.pageSize !== undefined) {
        validatePageSize(params.pageSize);
    }

    if (params['filter.geo'] !== undefined) {
        validateGeoFilter(params['filter.geo'], 'filter.geo');
    }

    if (params['postFilter.geo'] !== undefined) {
        validateGeoFilter(params['postFilter.geo'], 'postFilter.geo');
    }

    if (params.geoDecay !== undefined) {
        validateGeoDecay(params.geoDecay);
    }
}
