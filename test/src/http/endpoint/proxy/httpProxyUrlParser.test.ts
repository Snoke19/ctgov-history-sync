import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { HttpProxyUrlParser } from '../../../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { logger } from '../../../../../src/config/logging.js';

let warnSpy: jest.SpiedFunction<typeof logger.warn>;

jest.mock('../../../../../src/config/logging.js', () => ({
    logger: {
        warn: jest.fn(),
    },
}));

describe('HttpProxyUrlParser', () => {
    let parser: HttpProxyUrlParser;

    beforeEach(() => {
        parser = new HttpProxyUrlParser();
        jest.clearAllMocks();
        warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('returns an empty array for an empty string', () => {
        expect(parser.parse('')).toEqual([]);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('parses a single HTTP proxy', () => {
        expect(parser.parse('http://localhost:8080')).toEqual(['http://localhost:8080']);
    });

    it('parses a single HTTP proxy', () => {
        expect(parser.parse('http://localhost:8080')).toEqual(['http://localhost:8080']);
    });

    it('parses a single HTTPS proxy', () => {
        expect(parser.parse('https://localhost:8443')).toEqual(['https://localhost:8443']);
    });

    it('accepts proxy URLs with credentials', () => {
        expect(parser.parse('http://user:pass@localhost:8080')).toEqual(['http://user:pass@localhost:8080']);
    });

    it('parses multiple proxy URLs', () => {
        expect(parser.parse('http://a:8080,https://b:8443,http://c:9000')).toEqual([
            'http://a:8080',
            'https://b:8443',
            'http://c:9000',
        ]);
    });

    it('trims whitespace around proxy URLs', () => {
        expect(parser.parse('   http://a:8080   ,    https://b:8443   ')).toEqual(['http://a:8080', 'https://b:8443']);
    });

    it('rejects unsupported protocols', () => {
        expect(parser.parse('socks5://localhost:1080')).toEqual([]);

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('rejects URLs without a host', () => {
        expect(parser.parse('http://:8080')).toEqual([]);

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('rejects URLs without an explicit port', () => {
        expect(parser.parse('http://localhost')).toEqual([]);

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed URLs', () => {
        expect(parser.parse('this is not a url')).toEqual([]);

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('keeps valid URLs and skips invalid ones', () => {
        expect(parser.parse('http://a:8080,invalid,http://b:9000,http://localhost')).toEqual([
            'http://a:8080',
            'http://b:9000',
        ]);

        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('preserves the order of valid proxy URLs', () => {
        expect(parser.parse('http://c:3,http://a:1,http://b:2')).toEqual(['http://c:3', 'http://a:1', 'http://b:2']);
    });

    it('accepts explicitly specified default HTTP port', () => {
        expect(parser.parse('http://localhost:80')).toEqual(['http://localhost:80']);
    });

    it('accepts explicitly specified default HTTPS port', () => {
        expect(parser.parse('https://localhost:443')).toEqual(['https://localhost:443']);
    });

    it('ignores empty entries', () => {
        expect(parser.parse('http://a:8080,,http://b:8080,')).toEqual(['http://a:8080', 'http://b:8080']);
    });
});
