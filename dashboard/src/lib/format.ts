/** Formatting and small helpers (ported from util.js). All times are UTC. Nothing here produces markup. */

export const SEC = 1e3;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** The clock every relative time reads. Tests use fake timers (`vi.setSystemTime`), so `Date.now` is enough. */
export const now = (): number => Date.now();

export const enc = encodeURIComponent;
export const num = (n: number | string): string => Number(n).toLocaleString('en-US');
export const plural = (n: number, one: string, many?: string): string => `${num(n)} ${n === 1 ? one : many || one + 's'}`;
export const sum = (list: readonly number[]): number => list.reduce((a, b) => a + b, 0);
export const slug = (s: string): string => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
export const listText = (arr: readonly string[]): string =>
  arr.length <= 1 ? arr[0] || '' : arr.length === 2 ? `${arr[0]} and ${arr[1]}` : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
export const shortSha = (s: string | null | undefined): string => String(s || '').slice(0, 7);
export const shortId = (s: string | null | undefined): string => String(s || '').slice(0, 8);
export const hostOf = (url: string | null | undefined): string => String(url || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
export const isUuid = (s: unknown): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
export const platformLabel = (p: string | null | undefined): string => ({ macos: 'macOS', linux: 'Linux' } as Record<string, string>)[p ?? ''] || (p ? String(p) : 'Unknown platform');
export const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);
export const byTimeDesc = <K extends string>(key: K) => (a: Record<K, string | null | undefined>, b: Record<K, string | null | undefined>): number =>
  (Date.parse(b[key] ?? '') || 0) - (Date.parse(a[key] ?? '') || 0);
export const initial = (name: string | null | undefined): string => (String(name || '?').trim()[0] || '?').toUpperCase();
export const hash = (s: string): number => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};
export const avatarClass = (name: string | null | undefined): string => 'av-c' + (hash(String(name ?? '')) % 8);

/* ------------------------------------------------------------------ time */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const pad = (n: number): string => String(n).padStart(2, '0');

type Iso = string | null | undefined;

/** Epoch milliseconds of an ISO string, or null when it is missing or invalid. */
export const ms = (iso: Iso): number | null => {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
export const valid = (iso: Iso): boolean => ms(iso) !== null;

/** A duration as "12 s", "5 min", "3 h 20 min", "2 d 4 h" or "9 days". `precise` keeps minutes from 6 h on. */
export const span = (d: number, precise = false): string => {
  d = Math.max(0, d);
  const s = Math.round(d / SEC);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm && (precise || h < 6) ? `${h} h ${mm} min` : `${h} h`;
  const dd = Math.floor(h / 24);
  const hh = h % 24;
  if (dd < 7) return hh ? `${dd} d ${hh} h` : `${dd} d`;
  return `${dd} days`;
};
export const fmtTime = (iso: Iso): string => {
  const t = ms(iso);
  if (t === null) return '—';
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
export const fmtDay = (iso: Iso): string => {
  const t = ms(iso);
  if (t === null) return '—';
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
export const fmtFull = (iso: Iso): string => (ms(iso) === null ? '—' : `${fmtDay(iso)}, ${fmtTime(iso)}`);
export const fmtYearFull = (iso: Iso): string => {
  const t = ms(iso);
  return t === null ? '—' : `${fmtDay(iso)} ${new Date(t).getUTCFullYear()}, ${fmtTime(iso)}`;
};
/** "just now", "5 min ago", "on Sep 3" (after 60 days) or "never" for a missing time. */
export const rel = (iso: Iso): string => {
  const t = ms(iso);
  if (t === null) return 'never';
  const d = now() - t;
  if (d < 10 * SEC) return 'just now';
  if (d > 60 * DAY) return 'on ' + fmtDay(iso);
  return span(d) + ' ago';
};
/** "in 5 min", "now" or "—". */
export const until = (iso: Iso): string => {
  const t = ms(iso);
  return t === null ? '—' : t <= now() ? 'now' : 'in ' + span(t - now());
};
export const dayKey = (iso: string): string => new Date(ms(iso) ?? 0).toISOString().slice(0, 10);
export const dayLabel = (iso: string): string => {
  const k = dayKey(iso);
  if (k === new Date(now()).toISOString().slice(0, 10)) return 'Today';
  if (k === new Date(now() - DAY).toISOString().slice(0, 10)) return 'Yesterday';
  const d = new Date(ms(iso) ?? 0);
  return `${WDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
/** "m:ss" for a countdown in milliseconds. */
export const clock = (millis: number): string => {
  const s = Math.max(0, Math.ceil(millis / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
/** The text a live countdown shows: "expired", "in 40 s" or "in 5 min"; `fmt: 'clock'` shows m:ss. */
export const countdownText = (targetIso: Iso, fmt: 'clock' | 'words' = 'words', at: number = now()): string => {
  const left = (ms(targetIso) ?? 0) - at;
  return left <= 0 ? 'expired' : fmt === 'clock' ? clock(left) : left < MIN ? `in ${Math.ceil(left / 1000)} s` : `in ${Math.ceil(left / MIN)} min`;
};

/* ------------------------------------------------------------------ sizes and digests */

export const digestShort = (d: string | null | undefined): string => {
  const h = String(d || '').replace(/^sha256:/, '');
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
};
/** Binary units with one decimal (the Agent measures bytes with statvfs/statfs, `df -h` style): "871.2 GiB". */
export const bytes = (n: unknown): string => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let x = v;
  let i = 0;
  while (i < units.length - 1 && (i === 0 ? x : Math.round(x * 10) / 10) >= 1024) {
    x /= 1024;
    i++;
  }
  return i === 0 ? `${x} B` : `${x.toFixed(1)} ${units[i]}`;
};
export const percent = (value: number, digits = 1): string => `${Number(value.toFixed(digits))}%`;

/* ------------------------------------------------------------------ text with `code` spans */

export interface TextPart {
  text: string;
  code: boolean;
}
/**
 * Splits catalog text on backticks: `like this` becomes a code part. The old dashboard turned these into `<code>`
 * after escaping; here the parts are rendered by `MdText.vue` as text nodes, so no markup is ever produced from data.
 */
export function mdParts(source: string | null | undefined): TextPart[] {
  const parts: TextPart[] = [];
  const re = /`([^`]+)`/g;
  const s = String(source ?? '');
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index), code: false });
    parts.push({ text: m[1] ?? '', code: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last), code: false });
  return parts;
}
