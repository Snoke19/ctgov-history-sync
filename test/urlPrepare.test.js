import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {UrlBuilder} from '../src/urlPrepare.js';

const BASE = 'https://clinicaltrials.gov/api/int/studies';

describe('UrlBuilder', () => {

    describe('constructor', () => {
        it('strips trailing slash from base', () => {
            const url = new UrlBuilder(`${BASE}/`).build();
            assert.ok(!url.startsWith(`${BASE}//`));
        });
    });

    describe('path()', () => {
        it('appends single path segment', () => {
            const url = new UrlBuilder(BASE).path('NCT07697053').build();
            assert.equal(url, `${BASE}/NCT07697053`);
        });

        it('encodes special characters in path segment', () => {
            const url = new UrlBuilder(BASE).path('NCT 123/foo').build();
            assert.match(url, /NCT%20123%2Ffoo/);
        });

        it('chains multiple path segments in order', () => {
            const url = new UrlBuilder(BASE).path('v2').path('NCT07697053').build();
            assert.equal(url, `${BASE}/v2/NCT07697053`);
        });
    });

    describe('queryParam()', () => {
        it('appends a single query param', () => {
            const url = new UrlBuilder(BASE).path('NCT07697053').queryParam('history', true).build();
            assert.equal(url, `${BASE}/NCT07697053?history=true`);
        });

        it('chains multiple query params', () => {
            const url = new UrlBuilder(BASE)
                .path('NCT07697053')
                .queryParam('history', true)
                .queryParam('page', 1)
                .build();
            assert.equal(url, `${BASE}/NCT07697053?history=true&page=1`);
        });

        it('skips null value', () => {
            const url = new UrlBuilder(BASE).path('NCT07697053').queryParam('page', null).build();
            assert.equal(url, `${BASE}/NCT07697053`);
        });

        it('skips undefined value', () => {
            const url = new UrlBuilder(BASE).path('NCT07697053').queryParam('page', undefined).build();
            assert.equal(url, `${BASE}/NCT07697053`);
        });

        it('allows falsy but valid values (0, false, empty string)', () => {
            const url = new UrlBuilder(BASE)
                .path('NCT07697053')
                .queryParam('page', 0)
                .queryParam('history', false)
                .build();
            assert.match(url, /page=0/);
            assert.match(url, /history=false/);
        });
    });

    describe('queryParams()', () => {
        it('appends multiple params from object', () => {
            const url = new UrlBuilder(BASE)
                .path('NCT07697053')
                .queryParams({history: true, page: 1, limit: 10})
                .build();
            assert.match(url, /history=true/);
            assert.match(url, /page=1/);
            assert.match(url, /limit=10/);
        });

        it('skips null/undefined values in object', () => {
            const url = new UrlBuilder(BASE)
                .path('NCT07697053')
                .queryParams({history: true, page: null, limit: undefined})
                .build();
            assert.match(url, /history=true/);
            assert.ok(!url.includes('page'));
            assert.ok(!url.includes('limit'));
        });

        it('defaults to empty object — no query string appended', () => {
            const url = new UrlBuilder(BASE).path('NCT07697053').queryParams().build();
            assert.equal(url, `${BASE}/NCT07697053`);
        });
    });

    describe('build()', () => {
        it('omits ? when no params set', () => {
            const url = new UrlBuilder(BASE).path('NCT07697053').build();
            assert.ok(!url.includes('?'));
        });

        it('full URL — path + query params', () => {
            const url = new UrlBuilder(BASE)
                .path('NCT07697053')
                .queryParam('history', true)
                .build();
            assert.equal(url, `${BASE}/NCT07697053?history=true`);
        });
    });
});
