import { describe, expect, it } from '@jest/globals';
import { UrlBuilder } from '../src/http/urlPrepare.js';

describe('UrlBuilder', () => {
    it('builds a simple url without query', () => {
        const u = new UrlBuilder('https://api.example.com').path('study').build();
        expect(u).toBe('https://api.example.com/study');
    });

    it('encodes path segments', () => {
        const u = new UrlBuilder('https://api.example.com').path('a b').path('c/d').build();
        // segments are encoded individually; slash in second segment is encoded
        expect(u).toBe('https://api.example.com/a%20b/c%2Fd');
    });

    it('serializes array query params as repeated keys', () => {
        const u = new UrlBuilder('https://api.example.com')
            .queryParam('tag', ['a', 'b'])
            .queryParam('page', 2)
            .build();

        // order of query parameters is deterministic (append order)
        expect(u).toBe('https://api.example.com?tag=a&tag=b&page=2');
    });

    it('skips null and undefined query params', () => {
        const u = new UrlBuilder('https://api.example.com')
            .queryParam('a', null)
            .queryParam('b', undefined)
            .queryParam('c', 'x')
            .build();
        expect(u).toBe('https://api.example.com?c=x');
    });
});
