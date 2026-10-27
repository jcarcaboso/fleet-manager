import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAY, HOUR, MIN, avatarClass, byTimeDesc, bytes, clock, countdownText, dayKey, dayLabel, digestShort, fmtDay, fmtFull, fmtTime, fmtYearFull, hash, hostOf, initial,
  isUuid, listText, mdParts, ms, num, percent, platformLabel, plural, rel, shortId, shortSha, slug, span, until, valid,
} from '@/lib/format';

const NOW = Date.parse('2026-10-25T14:30:00Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe('small helpers', () => {
  it('formats numbers and plurals', () => {
    expect(num(1234567)).toBe('1,234,567');
    expect(plural(1, 'machine')).toBe('1 machine');
    expect(plural(2, 'machine')).toBe('2 machines');
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(2, 'status', 'statuses')).toBe('2 statuses');
  });
  it('joins lists in prose', () => {
    expect(listText([])).toBe('');
    expect(listText(['a'])).toBe('a');
    expect(listText(['a', 'b'])).toBe('a and b');
    expect(listText(['a', 'b', 'c'])).toBe('a, b and c');
  });
  it('shortens SHAs, IDs and hosts', () => {
    expect(shortSha('a3f9c21d0c5b4e8f')).toBe('a3f9c21');
    expect(shortSha(null)).toBe('');
    expect(shortId('00000000-0000-0000-0000-000000000001')).toBe('00000000');
    expect(hostOf('https://proxy.lab.internal/v1')).toBe('proxy.lab.internal');
    expect(hostOf(null)).toBe('');
  });
  it('recognises UUIDs, slugs and platforms', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(isUuid('a3f9c21')).toBe(false);
    expect(slug('Hello, World!')).toBe('hello-world-');
    expect(platformLabel('macos')).toBe('macOS');
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('freebsd')).toBe('freebsd');
    expect(platformLabel(null)).toBe('Unknown platform');
  });
  it('derives avatars deterministically', () => {
    expect(initial(' joan')).toBe('J');
    expect(initial('')).toBe('?');
    expect(initial(null)).toBe('?');
    expect(hash('abc')).toBe(hash('abc'));
    expect(avatarClass('joan')).toMatch(/^av-c[0-7]$/);
    expect(avatarClass('joan')).toBe(avatarClass('joan'));
  });
  it('sorts by time descending and tolerates missing times', () => {
    const rows = [{ t: '2026-01-01T00:00:00Z' }, { t: null }, { t: '2026-03-01T00:00:00Z' }];
    expect(rows.sort(byTimeDesc('t')).map(r => r.t)).toEqual(['2026-03-01T00:00:00Z', '2026-01-01T00:00:00Z', null]);
  });
});

describe('time', () => {
  it('parses ISO times', () => {
    expect(ms('2026-10-25T14:30:00Z')).toBe(NOW);
    expect(ms('nope')).toBeNull();
    expect(ms(null)).toBeNull();
    expect(valid('2026-10-25T14:30:00Z')).toBe(true);
    expect(valid(undefined)).toBe(false);
  });
  it('formats durations', () => {
    expect(span(0)).toBe('0 s');
    expect(span(12_000)).toBe('12 s');
    expect(span(5 * MIN)).toBe('5 min');
    expect(span(3 * HOUR + 20 * MIN)).toBe('3 h 20 min');
    expect(span(8 * HOUR + 20 * MIN)).toBe('8 h');
    expect(span(8 * HOUR + 20 * MIN, true)).toBe('8 h 20 min');
    expect(span(2 * DAY + 4 * HOUR)).toBe('2 d 4 h');
    expect(span(3 * DAY)).toBe('3 d');
    expect(span(9 * DAY)).toBe('9 days');
    expect(span(-5)).toBe('0 s');
  });
  it('formats UTC times and days', () => {
    expect(fmtTime('2026-10-25T09:05:00Z')).toBe('09:05');
    expect(fmtDay('2026-10-25T09:05:00Z')).toBe('Oct 25');
    expect(fmtFull('2026-10-25T09:05:00Z')).toBe('Oct 25, 09:05');
    expect(fmtYearFull('2026-10-25T09:05:00Z')).toBe('Oct 25 2026, 09:05');
    expect(fmtTime(null)).toBe('—');
    expect(fmtFull('nope')).toBe('—');
  });
  it('says how long ago', () => {
    const ago = (d: number): string => new Date(NOW - d).toISOString();
    expect(rel(null)).toBe('never');
    expect(rel(ago(2_000))).toBe('just now');
    expect(rel(ago(5 * MIN))).toBe('5 min ago');
    expect(rel(ago(26 * HOUR))).toBe('1 d 2 h ago');
    expect(rel(ago(61 * DAY))).toBe(`on ${fmtDay(ago(61 * DAY))}`);
  });
  it('says how long until', () => {
    expect(until(new Date(NOW + 5 * MIN).toISOString())).toBe('in 5 min');
    expect(until(new Date(NOW - 5 * MIN).toISOString())).toBe('now');
    expect(until(null)).toBe('—');
  });
  it('labels days', () => {
    expect(dayKey('2026-10-25T23:59:00Z')).toBe('2026-10-25');
    expect(dayLabel('2026-10-25T01:00:00Z')).toBe('Today');
    expect(dayLabel('2026-10-24T20:00:00Z')).toBe('Yesterday');
    expect(dayLabel('2026-10-20T20:00:00Z')).toBe('Tuesday, Oct 20');
  });
  it('formats clocks and countdowns', () => {
    expect(clock(61_000)).toBe('1:01');
    expect(clock(-5)).toBe('0:00');
    expect(countdownText(new Date(NOW + 40_000).toISOString())).toBe('in 40 s');
    expect(countdownText(new Date(NOW + 5 * MIN).toISOString())).toBe('in 5 min');
    expect(countdownText(new Date(NOW + 90_000).toISOString(), 'clock')).toBe('1:30');
    expect(countdownText(new Date(NOW - 1).toISOString())).toBe('expired');
  });
});

describe('sizes', () => {
  it('formats bytes in binary units with one decimal', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(1023)).toBe('1023 B');
    expect(bytes(1024)).toBe('1.0 KiB');
    expect(bytes(871203905536)).toBe('811.4 GiB');
    expect(bytes(994662584320)).toBe('926.4 GiB');
    expect(bytes(1024 ** 4)).toBe('1.0 TiB');
    expect(bytes(1024 ** 4 * 1.5)).toBe('1.5 TiB');
    expect(bytes(1024 ** 3 * 1023.97)).toBe('1.0 TiB');
  });
  it('rejects bad sizes', () => {
    expect(bytes(-1)).toBe('—');
    expect(bytes(NaN)).toBe('—');
    expect(bytes(undefined)).toBe('—');
  });
  it('formats percentages and digests', () => {
    expect(percent(92.34)).toBe('92.3%');
    expect(percent(85)).toBe('85%');
    expect(digestShort('sha256:' + 'ab'.repeat(32))).toBe('abababab…abab');
    expect(digestShort('sha256:abc')).toBe('abc');
    expect(digestShort(null)).toBe('');
  });
});

describe('mdParts', () => {
  it('splits backtick spans into code parts and never produces markup', () => {
    expect(mdParts('Run `fleet explain x` now')).toEqual([{ text: 'Run ', code: false }, { text: 'fleet explain x', code: true }, { text: ' now', code: false }]);
    expect(mdParts('plain')).toEqual([{ text: 'plain', code: false }]);
    expect(mdParts(null)).toEqual([]);
    expect(mdParts('<img src=x onerror=alert(1)>`<b>`')).toEqual([{ text: '<img src=x onerror=alert(1)>', code: false }, { text: '<b>', code: true }]);
  });
});
