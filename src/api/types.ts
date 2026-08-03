import {QueryParams} from '../http/types/http.js';

export interface FetchStudiesPageParams extends QueryParams {
    pageSize?: number;
    pageToken?: string;
    countTotal?: boolean;
    'query.term'?: string;
}

export interface FetchTrialDetailParams extends QueryParams {
    history?: boolean;
}

export interface Study {
    protocolSection?: {
        identificationModule?: {
            nctId?: string;
        };
    };
}

export interface StudiesPageResponse {
    studies: Study[];
    nextPageToken?: string;
}