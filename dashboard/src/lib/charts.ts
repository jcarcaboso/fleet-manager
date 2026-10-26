/**
 * Check-in chart geometry (ported from charts.js). Data comes from `GET nodes/{node}/checkins`: polls received per UTC hour,
 * oldest first. These functions only compute numbers and strings; `CheckinStrip.vue` and `CheckinChart.vue` draw them.
 */
import type { CheckinBucket } from '@/api/types';
import { HOUR, fmtDay, fmtTime, ms, num, plural, span, sum } from './format';

/** A rounded-top bar path. */
export function barPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h);
  const f = (v: number): string => v.toFixed(2);
  return `M${f(x)},${f(y + h)}V${f(y + r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(y + h)}Z`;
}
export function niceMax(v: number): number {
  if (v <= 5) return 5;
  const step = v <= 20 ? 5 : v <= 60 ? 10 : v <= 200 ? 20 : 50;
  return Math.ceil(v / step) * step;
}
export const totalPolls = (buckets: readonly CheckinBucket[]): number => sum(buckets.map(b => b.polls));

export interface Gap {
  from: string;
  to: number;
  /** Still going (no check-in since `from`). */
  open: boolean;
  hours: number;
  /** The whole window has no check-in. */
  none?: boolean;
}
/** Zero-poll runs of two or more hours. Quiet time before the first poll is not a gap. */
export function gaps(buckets: readonly CheckinBucket[]): Gap[] {
  const out: Gap[] = [];
  const first = buckets.findIndex(b => b.polls > 0);
  if (first === -1) {
    return buckets.length ? [{ from: buckets[0]!.hour, to: (ms(buckets[buckets.length - 1]!.hour) ?? 0) + HOUR, open: true, hours: buckets.length, none: true }] : [];
  }
  let start: number | null = null;
  for (let i = first; i < buckets.length; i++) {
    if (buckets[i]!.polls === 0) {
      if (start === null) start = i;
    } else if (start !== null) {
      if (i - start >= 2) out.push({ from: buckets[start]!.hour, to: ms(buckets[i]!.hour) ?? 0, open: false, hours: i - start });
      start = null;
    }
  }
  if (start !== null && buckets.length - start >= 2) {
    out.push({ from: buckets[start]!.hour, to: (ms(buckets[buckets.length - 1]!.hour) ?? 0) + HOUR, open: true, hours: buckets.length - start });
  }
  return out;
}

/** The accessible name of a chart: the total and the gaps. */
export function chartLabel(buckets: readonly CheckinBucket[], hours: number = buckets.length): string {
  const g = gaps(buckets);
  const window = hours > 24 ? `the last ${Math.round(hours / 24)} days` : `the last ${hours} hours`;
  const gapText = g.length
    ? g.map(x => (x.none ? 'No check-ins in this window' : x.open ? `none since ${fmtTime(x.from)} UTC` : `none from ${fmtTime(x.from)} to ${fmtTime(new Date(x.to).toISOString())} UTC`)).join('; ')
    : 'No gaps.';
  return `Check-ins in ${window}: ${num(totalPolls(buckets))}. ${gapText}`;
}
/** The tooltip text of hour `i`: "5 check-ins|14:00–15:00 UTC" (value|label, as `Tooltip` reads it). */
export function bucketTip(buckets: readonly CheckinBucket[], i: number): string {
  const b = buckets[i];
  if (!b) return '';
  const start = ms(b.hour) ?? 0;
  const end = new Date(start + HOUR).toISOString();
  const day = buckets.length > 30 ? `${fmtDay(b.hour)}, ` : '';
  return `${b.polls ? plural(b.polls, 'check-in') : 'No check-ins'}|${day}${fmtTime(b.hour)}–${fmtTime(end)} UTC`;
}
/** The line list under the full chart. */
export interface GapLine {
  open: boolean;
  text: string;
}
export function gapLines(buckets: readonly CheckinBucket[], { revoked = false }: { revoked?: boolean } = {}): GapLine[] {
  return gaps(buckets).map(g => {
    const to = new Date(g.to).toISOString();
    const text = g.none ? (revoked ? 'No check-ins in this window. This machine is revoked.' : 'No check-ins in this window.')
      : g.open ? `No check-ins since ${fmtTime(g.from)} UTC (${span(g.hours * HOUR)} so far).`
        : `No check-ins ${fmtTime(g.from)}–${fmtTime(to)} UTC (${g.hours} h), ${fmtDay(g.from)}.`;
    return { open: g.open, text };
  });
}

/* ------------------------------------------------------------------ small strip (gallery cards) */

export const STRIP = { W: 240, H: 24, base: 22 } as const;
export interface StripBar {
  i: number;
  /** A path for a bar with polls, or a rectangle for an empty hour. */
  path?: string;
  rect?: { x: number; y: number; width: number; height: number; rx: number };
}
export function stripBars(buckets: readonly CheckinBucket[]): StripBar[] {
  const n = buckets.length || 1;
  const pitch = STRIP.W / n;
  const bw = Math.max(1.5, pitch - 2);
  const max = Math.max(1, ...buckets.map(b => b.polls));
  return buckets.map((b, i) => {
    const x = i * pitch + 1;
    if (b.polls > 0) {
      const h = Math.max(3, (b.polls / max) * 20);
      return { i, path: barPath(x, STRIP.base - h, bw, h, 1.4) };
    }
    return { i, rect: { x: Number(x.toFixed(2)), y: 20.4, width: Number(bw.toFixed(2)), height: 1.6, rx: 0.8 } };
  });
}

/* ------------------------------------------------------------------ full chart (Node page) */

export const CH = { W: 720, H: 152, L: 40, R: 10, T: 12, B: 122 } as const;
export interface ChartGrid {
  y: number;
  label: string;
  axis: boolean;
}
export interface ChartTick {
  x: number;
  text: string;
}
export interface ChartBar {
  i: number;
  path?: string;
  rect?: { x: number; y: number; width: number; height: number; rx: number };
}
export interface ChartModel {
  max: number;
  slot: number;
  grid: ChartGrid[];
  ticks: ChartTick[];
  bars: ChartBar[];
}
export const chartSlot = (n: number): number => (CH.W - CH.L - CH.R) / (n || 1);
/** The x of the middle of hour `i`. */
export const chartX = (i: number, n: number): number => CH.L + (i + 0.5) * chartSlot(n);
export const chartY = (polls: number, max: number): number => CH.B - (polls / max) * (CH.B - CH.T);
export function chartModel(buckets: readonly CheckinBucket[]): ChartModel {
  const n = buckets.length || 1;
  const slot = chartSlot(n);
  const bw = Math.max(1.2, Math.min(24, slot - (slot > 8 ? 3 : 1)));
  const max = niceMax(Math.max(0, ...buckets.map(b => b.polls)));
  const grid = [0, max / 2, max].map(v => ({ y: Number(chartY(v, max).toFixed(1)), label: String(Math.round(v)), axis: v === 0 }));
  /* X ticks: every 6 h for a day, every day boundary for a week. */
  const ticks: ChartTick[] = [];
  buckets.forEach((b, i) => {
    const h = new Date(ms(b.hour) ?? 0).getUTCHours();
    if (n <= 36 ? h % 6 === 0 : h === 0) {
      const x = CH.L + (i + 0.5) * slot;
      if (x < CH.L + 14 || x > CH.W - CH.R - 44) return;
      ticks.push({ x: Number(x.toFixed(1)), text: n <= 36 ? fmtTime(b.hour) : fmtDay(b.hour) });
    }
  });
  const bars = buckets.map((b, i): ChartBar => {
    const x = CH.L + i * slot + (slot - bw) / 2;
    return b.polls > 0
      ? { i, path: barPath(x, chartY(b.polls, max), bw, CH.B - chartY(b.polls, max), Math.min(3, bw / 2)) }
      : { i, rect: { x: Number(x.toFixed(2)), y: CH.B - 2, width: Number(bw.toFixed(2)), height: 2, rx: 1 } };
  });
  return { max, slot, grid, ticks, bars };
}
