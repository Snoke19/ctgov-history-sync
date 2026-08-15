import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const warnMock = jest.fn();

jest.unstable_mockModule('../../../../../src/config/logging.js', () => ({
    createLogger: () => ({
        warn: warnMock,
    }),
}));

const { HttpProxyUrlParser: HttpProxyUrlParserClass } =
    await import('../../../../../src/http/endpoint/proxy/httpProxyUrlParser.js');

describe('HttpProxyUrlParser', () => {
    let parser: InstanceType<typeof HttpProxyUrlParserClass>;

    beforeEach(() => {
        parser = new HttpProxyUrlParserClass();
        warnMock.mockClear();
    });

    it('redacts proxy credentials from validation logs', () => {
        parser.parse('http://user:secret@proxy.example.com:8080/path');

        expect(warnMock).toHaveBeenCalledTimes(1);

        const logArguments = warnMock.mock.calls[0] ?? [];

        expect(logArguments.join(' ')).not.toContain('secret');
        expect(logArguments.join(' ')).not.toContain('user:secret@');
        expect(logArguments.join(' ')).toContain('proxy.example.com:8080');
    });

    it('does not leak credentials when the proxy URL cannot be parsed', () => {
        parser.parse('http://user:secret@invalid host:8080');

        expect(warnMock).toHaveBeenCalledTimes(1);

        const logArguments = warnMock.mock.calls[0] ?? [];

        expect(logArguments.join(' ')).not.toContain('secret');
        expect(logArguments.join(' ')).not.toContain('user:secret@');
        expect(logArguments.join(' ')).toContain('<invalid proxy URL>');
    });

    it('does not leak credentials when the proxy URL is malformed', () => {
        parser.parse('http://user:secret@invalid host:8080');

        expect(warnMock).toHaveBeenCalled();
        expect(warnMock.mock.calls[0]?.join(' ')).not.toContain('secret');
    });

    describe('valid inputs', () => {
        it('returns an empty array for an empty string', () => {
            expect(parser.parse('')).toEqual([]);
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

        it('parses multiple comma-separated URLs', () => {
            expect(parser.parse('http://a:8080,https://b:8443,http://c:9000')).toEqual([
                'http://a:8080',
                'https://b:8443',
                'http://c:9000',
            ]);
        });

        it('trims whitespace around URLs', () => {
            expect(parser.parse('   http://a:8080   ,    https://b:8443   ')).toEqual([
                'http://a:8080',
                'https://b:8443',
            ]);
        });

        it('preserves order of valid URLs', () => {
            expect(parser.parse('http://c:3,http://a:1,http://b:2')).toEqual([
                'http://c:3',
                'http://a:1',
                'http://b:2',
            ]);
        });

        it('accepts explicit default HTTP port (80)', () => {
            expect(parser.parse('http://localhost:80')).toEqual(['http://localhost:80']);
        });

        it('accepts explicit default HTTPS port (443)', () => {
            expect(parser.parse('https://localhost:443')).toEqual(['https://localhost:443']);
        });

        it('ignores empty entries between commas', () => {
            expect(parser.parse('http://a:8080,,http://b:8080,')).toEqual(['http://a:8080', 'http://b:8080']);
        });

        it('handles IPv6 addresses', () => {
            expect(parser.parse('http://[::1]:8080')).toEqual(['http://[::1]:8080']);
        });

        it('handles @ in password', () => {
            expect(parser.parse('http://user:p@ss@localhost:8080')).toEqual(['http://user:p@ss@localhost:8080']);
        });
    });

    describe('invalid inputs', () => {
        it('rejects port 0', () => {
            expect(parser.parse('http://localhost:0')).toEqual([]);
        });

        it('rejects port above 65535', () => {
            expect(parser.parse('http://localhost:65536')).toEqual([]);
        });

        it('rejects URLs with path', () => {
            expect(parser.parse('http://localhost:8080/path')).toEqual([]);
        });

        it('rejects URLs with query or hash', () => {
            expect(parser.parse('http://localhost:8080?query=1')).toEqual([]);
            expect(parser.parse('http://localhost:8080#frag')).toEqual([]);
        });

        it('rejects unsupported protocols', () => {
            expect(parser.parse('socks5://localhost:1080')).toEqual([]);
        });

        it('rejects URLs without a host', () => {
            expect(parser.parse('http://:8080')).toEqual([]);
        });

        it('rejects URLs without an explicit port', () => {
            expect(parser.parse('http://localhost')).toEqual([]);
        });

        it('rejects malformed URLs', () => {
            expect(parser.parse('this is not a url')).toEqual([]);
        });

        it('keeps valid URLs and skips invalid ones', () => {
            expect(parser.parse('http://a:8080,invalid,http://b:9000,http://localhost')).toEqual([
                'http://a:8080',
                'http://b:9000',
            ]);
        });

        it('rejects out-of-range ports', () => {
            expect(parser.parse('http://localhost:99999')).toEqual([]);
        });

        it('rejects all-empty input', () => {
            expect(parser.parse(',,,')).toEqual([]);
        });
    });
});
