import { QueryParams, QueryParamValue } from './types/http.js';

export class UrlBuilder {
    private readonly base: string;
    private readonly segments: string[] = [];
    private readonly params: URLSearchParams = new URLSearchParams();

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

    public queryParam(key: string, value: QueryParamValue | QueryParamValue[] | null | undefined): this {
        if (value === null || value === undefined) return this;

        if (Array.isArray(value)) {
            for (const v of value) {
                if (v !== null && v !== undefined) this.params.append(key, String(v));
            }
        } else {
            this.params.append(key, String(value));
        }

        return this;
    }

    public queryParams(params: QueryParams = {}): this {
        for (const [key, value] of Object.entries(params)) {
            const val = value as QueryParamValue | QueryParamValue[] | undefined;
            this.queryParam(key, val);
        }
        return this;
    }

    public build(): string {
        const path = this.segments.join('/');
        const queryString = this.params.toString();
        const baseUrl = path.length > 0 ? `${this.base}/${path}` : this.base;
        return queryString.length > 0 ? `${baseUrl}?${queryString}` : baseUrl;
    }

    public toString(): string {
        return this.build();
    }
}
