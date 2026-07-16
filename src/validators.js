import {TrialValidationError} from "./error/errors.js";

const geoPattern = /^distance\(-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?(km|mi)?\)$/;
const decayPattern = /^func:(gauss|exp|linear),scale:(\d+(\.\d+)?(km|mi)),offset:(\d+(\.\d+)?(km|mi)),decay:(\d+(\.\d+)?)$/;

export function validateNctId(value) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new TrialValidationError(`nctId must be a non-empty string`);
    }
}

export function validateGeoFilter(value, paramName = "filter.geo") {
    if (typeof value !== "string" || !geoPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid ${paramName} format. Expected: distance(lat,lon,dist)[km|mi]. Got: "${value}"`
        );
    }
}

export function validateGeoDecay(value) {
    if (typeof value !== "string") {
        throw new TrialValidationError("geoDecay must be a string");
    }

    if (!decayPattern.test(value.trim())) {
        throw new TrialValidationError(
            `Invalid geoDecay format. Expected: func:(gauss|exp|linear),scale:<dist><km|mi>,offset:<dist><km|mi>,decay:<number>. Got: "${value}"`
        );
    }
}

export function validatePageSize(value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new TrialValidationError("pageSize must be a positive integer");
    }
}

export function validateSearchParams(params) {
    if ("pageSize" in params) {
        validatePageSize(params.pageSize);
    }

    if ("filter.geo" in params) {
        validateGeoFilter(params["filter.geo"], "filter.geo");
    }

    if ("postFilter.geo" in params) {
        validateGeoFilter(params["postFilter.geo"], "postFilter.geo");
    }

    if ("geoDecay" in params) {
        validateGeoDecay(params.geoDecay);
    }
}
