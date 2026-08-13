import { ApiResponseValidationError } from '../error/errors.js';
import { StudiesPageResponse, Study } from './types.js';

export function parseStudiesPageResponse(value: unknown, url: string): StudiesPageResponse {
    if (!isStudiesPageResponse(value)) {
        throw new ApiResponseValidationError(url, 'Expected a valid studies page response.');
    }

    return value;
}

function isStudiesPageResponse(value: unknown): value is StudiesPageResponse {
    if (!isRecord(value)) {
        return false;
    }

    if (!Array.isArray(value.studies)) {
        return false;
    }

    if (value.nextPageToken !== undefined && typeof value.nextPageToken !== 'string') {
        return false;
    }

    return value.studies.every(isStudy);
}

function isStudy(value: unknown): value is Study {
    if (!isRecord(value)) {
        return false;
    }

    const { protocolSection } = value;

    if (protocolSection === undefined) {
        return true;
    }

    if (!isRecord(protocolSection)) {
        return false;
    }

    const { identificationModule } = protocolSection;

    if (identificationModule === undefined) {
        return true;
    }

    if (!isRecord(identificationModule)) {
        return false;
    }

    const { nctId } = identificationModule;

    return nctId === undefined || typeof nctId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}
