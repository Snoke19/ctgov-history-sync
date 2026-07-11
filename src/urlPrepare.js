export class UrlBuilder {
    #base;
    #segments = [];
    #params = {};

    constructor(base) {
        this.#base = base.replace(/\/$/, '');
    }

    path(segment) {
        this.#segments.push(encodeURIComponent(segment));
        return this;
    }

    queryParam(key, value) {
        if (value !== null && value !== undefined) {
            this.#params[key] = value;
        }
        return this;
    }

    queryParams(params = {}) {
        for (const [key, value] of Object.entries(params)) {
            this.queryParam(key, value);
        }
        return this;
    }

    build() {
        const path = this.#segments.join('/');
        const qs = new URLSearchParams(this.#params).toString();
        return `${this.#base}/${path}${qs ? `?${qs}` : ''}`;
    }
}
