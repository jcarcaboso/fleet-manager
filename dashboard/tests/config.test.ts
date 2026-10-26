import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, validateApiUrl } from '@/config';
import { jsonResponse, scriptedFetch } from './helpers/fetch';

describe('validateApiUrl', () => {
  it('accepts an https origin and returns it normalised', () => {
    expect(validateApiUrl('https://fleet.home.arpa:7443')).toBe('https://fleet.home.arpa:7443');
    expect(validateApiUrl('https://fleet.home.arpa:7443/')).toBe('https://fleet.home.arpa:7443');
    expect(validateApiUrl('  https://FLEET.home.arpa  ')).toBe('https://fleet.home.arpa');
    expect(validateApiUrl('https://localhost:7443')).toBe('https://localhost:7443');
  });
  it('accepts plain http only for localhost and 127.0.0.1', () => {
    expect(validateApiUrl('http://localhost:7443')).toBe('http://localhost:7443');
    expect(validateApiUrl('http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000');
    expect(() => validateApiUrl('http://fleet.home.arpa:7443')).toThrow(/https/);
    expect(() => validateApiUrl('http://192.168.1.5')).toThrow(/https/);
    expect(() => validateApiUrl('http://localhost.evil.example')).toThrow(/https/);
    expect(() => validateApiUrl('ftp://localhost')).toThrow(/https/);
  });
  it('rejects anything that is not an origin', () => {
    for (const bad of ['https://fleet.home.arpa/api', 'https://fleet.home.arpa?x=1', 'https://fleet.home.arpa#frag', 'https://user:pw@fleet.home.arpa']) {
      expect(() => validateApiUrl(bad), bad).toThrow(ConfigError);
    }
  });
  it('rejects missing and invalid values with a message that says what to fix', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, 'not a url', '//fleet.home.arpa']) {
      expect(() => validateApiUrl(bad), String(bad)).toThrow(ConfigError);
    }
    expect(() => validateApiUrl(undefined)).toThrow(/apiUrl/);
  });
});

describe('loadConfig', () => {
  it('fetches /config.json without caching and validates it', async () => {
    const { fetch, seen } = scriptedFetch(jsonResponse({ apiUrl: 'https://fleet.home.arpa:7443/' }));
    await expect(loadConfig(fetch)).resolves.toEqual({ apiUrl: 'https://fleet.home.arpa:7443' });
    expect(seen[0]!.url).toBe('/config.json');
    expect(seen[0]!.init.cache).toBe('no-store');
    expect(seen[0]!.init.credentials).toBe('omit');
  });
  it('reports a missing file', async () => {
    const { fetch } = scriptedFetch(new Response('not found', { status: 404 }));
    await expect(loadConfig(fetch)).rejects.toThrow(/HTTP 404/);
  });
  it('reports a file that is not JSON (for example the index.html fallback)', async () => {
    const { fetch } = scriptedFetch(new Response('<!doctype html><title>x</title>', { status: 200 }));
    await expect(loadConfig(fetch)).rejects.toThrow(/not valid JSON/);
  });
  it('reports a network failure', async () => {
    const { fetch } = scriptedFetch(new TypeError('Failed to fetch'));
    await expect(loadConfig(fetch)).rejects.toThrow(/could not be loaded/);
  });
  it('reports a wrong shape and a bad apiUrl', async () => {
    await expect(loadConfig(scriptedFetch(jsonResponse([1])).fetch)).rejects.toThrow(/JSON object/);
    await expect(loadConfig(scriptedFetch(jsonResponse({})).fetch)).rejects.toThrow(/apiUrl/);
    await expect(loadConfig(scriptedFetch(jsonResponse({ apiUrl: 'http://fleet.home.arpa' })).fetch)).rejects.toThrow(/https/);
  });
  it('every failure is a ConfigError, which main.ts turns into the configuration error page', async () => {
    await expect(loadConfig(scriptedFetch(new Response('', { status: 500 })).fetch)).rejects.toBeInstanceOf(ConfigError);
  });
});
