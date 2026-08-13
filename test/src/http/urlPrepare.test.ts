import { describe, expect, it } from '@jest/globals';
import { UrlBuilder } from '../../../src/http/urlPrepare.js';

describe('UrlBuilder', () => {
    it('removes a previously set parameter when value is null', () => {
        expect(new UrlBuilder('https://api.test').queryParam('term', 'cancer').queryParam('term', null).build()).toBe(
            'https://api.test',
        );
    });

    it('removes a previously set parameter when value is undefined', () => {
        expect(
            new UrlBuilder('https://api.test').queryParam('term', 'cancer').queryParam('term', undefined).build(),
        ).toBe('https://api.test');
    });

    it('replaces a previous scalar value when an array is set', () => {
        expect(
            new UrlBuilder('https://api.test')
                .queryParam('term', 'cancer')
                .queryParam('term', ['diabetes', 'asthma'])
                .build(),
        ).toBe('https://api.test?term=diabetes&term=asthma');
    });

    it('replaces a previous array when a scalar is set', () => {
        expect(
            new UrlBuilder('https://api.test')
                .queryParam('term', ['cancer', 'diabetes'])
                .queryParam('term', 'asthma')
                .build(),
        ).toBe('https://api.test?term=asthma');
    });

    it('serializes string arrays as repeated query parameters', () => {
        expect(new UrlBuilder('https://api.test').queryParam('term', ['cancer', 'diabetes']).build()).toBe(
            'https://api.test?term=cancer&term=diabetes',
        );
    });

    it('serializes multiple array parameters correctly', () => {
        expect(
            new UrlBuilder('https://api.test')
                .queryParams({
                    term: ['cancer', 'diabetes'],
                    type: ['interventional', 'observational'],
                })
                .build(),
        ).toBe('https://api.test?term=cancer&term=diabetes&type=interventional&type=observational');
    });

    it('omits an empty array', () => {
        expect(new UrlBuilder('https://api.test').queryParam('term', []).build()).toBe('https://api.test');
    });

    describe('constructor', () => {
        it('throws a TypeError for an empty base', () => {
            expect(() => new UrlBuilder('')).toThrow(TypeError);
        });

        it('throws a TypeError for a non-string base', () => {
            expect(() => new UrlBuilder(undefined as unknown as string)).toThrow(TypeError);
        });

        it('strips trailing slashes from the base', () => {
            expect(new UrlBuilder('https://api.test/').build()).toBe('https://api.test');
        });
    });

    describe('path', () => {
        it('builds the bare base when no segments are added', () => {
            expect(new UrlBuilder('https://api.test').build()).toBe('https://api.test');
        });

        it('joins multiple segments with slashes', () => {
            expect(new UrlBuilder('https://api.test').path('a').path('b').build()).toBe('https://api.test/a/b');
        });

        it('URL-encodes each segment', () => {
            expect(new UrlBuilder('https://api.test').path('NCT 0000/1').build()).toBe(
                'https://api.test/NCT%200000%2F1',
            );
        });
    });

    describe('queryParam', () => {
        it('appends a query string for string values', () => {
            expect(new UrlBuilder('https://api.test').queryParam('q', 'cancer').build()).toBe(
                'https://api.test?q=cancer',
            );
        });

        it('stringifies number and boolean values', () => {
            const url = new UrlBuilder('https://api.test');
            expect(url.queryParam('n', 42).queryParam('flag', true).build()).toBe('https://api.test?n=42&flag=true');
        });

        it('omits null values', () => {
            expect(new UrlBuilder('https://api.test').queryParam('q', null).build()).toBe('https://api.test');
        });

        it('omits undefined values', () => {
            expect(new UrlBuilder('https://api.test').queryParam('q', undefined).build()).toBe('https://api.test');
        });
    });

    describe('queryParams', () => {
        it('merges multiple params into one query string', () => {
            const url = new UrlBuilder('https://api.test').queryParams({ pageSize: 100, 'query.term': 'cancer' });
            expect(url.build()).toBe('https://api.test?pageSize=100&query.term=cancer');
        });

        it('builds with no query string for an empty params object', () => {
            expect(new UrlBuilder('https://api.test').queryParams({}).build()).toBe('https://api.test');
        });

        it('applies values after path segments and extends previously set params', () => {
            const url = new UrlBuilder('https://api.test').path('NCT00000001').queryParam('history', true);
            expect(url.queryParams({ format: 'json' }).build()).toBe(
                'https://api.test/NCT00000001?history=true&format=json',
            );
        });
    });

    describe('build / toString', () => {
        it('toString delegates to build', () => {
            const builder = new UrlBuilder('https://api.test').queryParam('a', 1);
            expect(builder.toString()).toBe(builder.build());
        });

        it('build is stable across repeated calls', () => {
            const builder = new UrlBuilder('https://api.test').path('x').queryParam('a', 1);
            const first = builder.build();
            expect(builder.build()).toBe(first);
        });
    });
});
