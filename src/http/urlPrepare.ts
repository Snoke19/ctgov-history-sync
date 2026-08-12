import { QueryParams, QueryParamValue } from './types/http.js';

export interface IUrlBuilder {
    path(segment: string): this;
    queryParam(key: string, value: QueryParamValue | null | undefined): this;
    queryParams(params?: QueryParams): this;
    build(): string;
    toString(): string;
}

export class UrlBuilder implements IUrlBuilder {
    private readonly base: string;
    private readonly segments: string[] = [];
    private readonly params: Record<string, string> = {};

    public constructor(base: string) {
        if (typeof base !== 'string' || base.length === 0) {
            throw new TypeError('Base URL must be a non-empty string');
        }
        this.base = base.replace(/\/+$/, '');
    }

    public path(segment: string): this {
        this.segments.push(encodeURIComponent(segment));
        return this;
    }

    public queryParam(key: string, value: QueryParamValue | null | undefined): this {
        if (value !== null && value !== undefined) {
            this.params[key] = String(value);
        }
        return this;
    }

    public queryParams(params: QueryParams = {}): this {
        for (const [key, value] of Object.entries(params)) {
            this.queryParam(key, value as QueryParamValue | undefined);
        }
        return this;
    }

    public build(): string {
        const path = this.segments.join('/');
        const queryString = new URLSearchParams(this.params).toString();
        const baseUrl = path.length > 0 ? `${this.base}/${path}` : this.base;
        return queryString.length > 0 ? `${baseUrl}?${queryString}` : baseUrl;
    }

    public toString(): string {
        return this.build();
    }
}
