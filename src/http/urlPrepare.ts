import { QueryParams, QueryParamInput } from './types/http.js';

export class UrlBuilder {
    private readonly base: string;
    private readonly segments: string[] = [];
    private readonly params = new URLSearchParams();

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

    public queryParam(key: string, value: QueryParamInput): this {
        if (value === null || value === undefined) {
            this.params.delete(key);
            return this;
        }

        if (Array.isArray(value)) {
            this.params.delete(key);

            for (const item of value) {
                this.params.append(key, item);
            }

            return this;
        }

        this.params.set(key, String(value));
        return this;
    }

    public queryParams(params: QueryParams = {}): this {
        for (const [key, value] of Object.entries(params)) {
            this.queryParam(key, value);
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
