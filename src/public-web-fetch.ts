import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

function privateIpv4(address: string): boolean {
	const octets = address.split('.').map(Number);
	if (octets.length !== 4 || octets.some(value => !Number.isInteger(value)))
		return true;
	const [a, b] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b! >= 16 && b! <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b! >= 64 && b! <= 127) ||
		a! >= 224
	);
}

function privateIpv6(address: string): boolean {
	const normalized = address.toLowerCase().split('%')[0]!;
	return (
		normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb') ||
		normalized.startsWith('::ffff:127.') ||
		normalized.startsWith('::ffff:10.') ||
		normalized.startsWith('::ffff:192.168.')
	);
}

export function isPrivateAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return privateIpv4(address);
	if (version === 6) return privateIpv6(address);
	return true;
}

export async function assertPublicUrl(url: URL): Promise<void> {
	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new Error('only HTTP and HTTPS URLs are supported');
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal')
	) {
		throw new Error('local and private network URLs are blocked');
	}
	const directVersion = isIP(hostname);
	if (directVersion && isPrivateAddress(hostname)) {
		throw new Error('local and private network URLs are blocked');
	}
	if (!directVersion) {
		const addresses = await lookup(hostname, {all: true, verbatim: true});
		if (
			addresses.length === 0 ||
			addresses.some(entry => isPrivateAddress(entry.address))
		) {
			throw new Error('URL resolves to a local or private network address');
		}
	}
}

export async function fetchPublicText(
	initial: URL,
	options: {timeoutMs?: number; maxBytes?: number; maxChars?: number} = {},
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
	const maxChars = options.maxChars ?? 200_000;
	let current = initial;
	for (let redirects = 0; redirects <= 5; redirects++) {
		await assertPublicUrl(current);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(current, {
				headers: {
					'User-Agent': 'BoboNyo/1.0',
					Accept: 'text/*, application/json, application/xml, text/html',
				},
				redirect: 'manual',
				signal: controller.signal,
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				if (!location)
					throw new Error(`HTTP ${response.status} redirect omitted Location`);
				current = new URL(location, current);
				continue;
			}
			if (!response.ok)
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			const length = Number(response.headers.get('content-length') || 0);
			if (length > maxBytes)
				throw new Error(`response exceeds the ${maxBytes} byte limit`);
			const type = response.headers.get('content-type')?.toLowerCase() || '';
			if (type && !/(?:text\/|json|xml|javascript|xhtml)/.test(type)) {
				throw new Error(`unsupported binary content type ${type}`);
			}
			const text = await response.text();
			if (new TextEncoder().encode(text).byteLength > maxBytes) {
				throw new Error(`response exceeds the ${maxBytes} byte limit`);
			}
			return text.length > maxChars
				? `${text.slice(0, maxChars)}\n… response truncated`
				: text;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error('too many redirects');
}
