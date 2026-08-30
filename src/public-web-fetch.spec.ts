import {describe, expect, test} from 'bun:test';
import {assertPublicUrl, isPrivateAddress} from './public-web-fetch';

describe('public web fetch SSRF guard', () => {
	test('recognizes private IPv4 and IPv6 ranges', () => {
		expect(isPrivateAddress('127.0.0.1')).toBe(true);
		expect(isPrivateAddress('10.1.2.3')).toBe(true);
		expect(isPrivateAddress('192.168.1.2')).toBe(true);
		expect(isPrivateAddress('::1')).toBe(true);
		expect(isPrivateAddress('fd00::1')).toBe(true);
		expect(isPrivateAddress('8.8.8.8')).toBe(false);
	});

	test('blocks local hostnames and non-http protocols', async () => {
		await expect(
			assertPublicUrl(new URL('http://localhost/test')),
		).rejects.toThrow(/private network/);
		await expect(
			assertPublicUrl(new URL('file:///etc/passwd')),
		).rejects.toThrow(/HTTP and HTTPS/);
	});
});
