import { describe, expect, it } from 'vitest';
import type { CheckinBucket } from '@/api/types';
import { CH, STRIP, barPath, bucketTip, chartLabel, chartModel, chartX, gapLines, gaps, niceMax, stripBars, totalPolls } from '@/lib/charts';

const hour = (i: number, polls: number): CheckinBucket => ({ hour: new Date(Date.UTC(2026, 9, 25, i)).toISOString(), polls });
const day = (polls: number[]): CheckinBucket[] => polls.map((p, i) => hour(i, p));

describe('check-in charts', () => {
  it('rounds the axis maximum', () => {
    expect([0, 3, 5, 6, 20, 21, 60, 61, 200, 201].map(niceMax)).toEqual([5, 5, 5, 10, 20, 30, 60, 80, 200, 250]);
  });
  it('totals polls', () => {
    expect(totalPolls(day([1, 2, 3]))).toBe(6);
  });
  it('finds gaps of two hours or more and ignores quiet time before the first poll', () => {
    expect(gaps([])).toEqual([]);
    const lead = day([0, 0, 5, 5, 0, 5, 0, 0, 0]);
    const g = gaps(lead);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ open: true, hours: 3 });
    expect(gaps(day([5, 0, 0, 5]))[0]).toMatchObject({ open: false, hours: 2 });
    expect(gaps(day([5, 0, 5]))).toEqual([]);
    expect(gaps(day([0, 0, 0]))[0]).toMatchObject({ none: true, open: true, hours: 3 });
  });
  it('labels the chart with the total and the gaps', () => {
    expect(chartLabel(day([5, 0, 0, 5]))).toBe('Check-ins in the last 4 hours: 10. none from 01:00 to 03:00 UTC');
    expect(chartLabel(day([1, 1]))).toBe('Check-ins in the last 2 hours: 2. No gaps.');
    expect(chartLabel(day([0, 0]))).toContain('No check-ins in this window');
    expect(chartLabel(day([5, 0, 0]))).toContain('none since 01:00 UTC');
    expect(chartLabel(day(Array(168).fill(1)))).toContain('the last 7 days');
  });
  it('words the tooltip', () => {
    const b = day([0, 1, 5]);
    expect(bucketTip(b, 0)).toBe('No check-ins|00:00–01:00 UTC');
    expect(bucketTip(b, 1)).toBe('1 check-in|01:00–02:00 UTC');
    expect(bucketTip(b, 2)).toBe('5 check-ins|02:00–03:00 UTC');
    expect(bucketTip(b, 9)).toBe('');
    const week = Array.from({ length: 48 }, (_, i) => ({ hour: new Date(Date.UTC(2026, 9, 24, i)).toISOString(), polls: 1 }));
    expect(bucketTip(week, 0)).toBe('1 check-in|Oct 24, 00:00–01:00 UTC');
  });
  it('describes the gap lines', () => {
    expect(gapLines(day([5, 0, 0, 5]))[0]).toEqual({ open: false, text: 'No check-ins 01:00–03:00 UTC (2 h), Oct 25.' });
    expect(gapLines(day([5, 0, 0]))[0]).toMatchObject({ open: true, text: 'No check-ins since 01:00 UTC (2 h so far).' });
    expect(gapLines(day([0, 0]), { revoked: true })[0]!.text).toBe('No check-ins in this window. This machine is revoked.');
    expect(gapLines(day([1, 1]))).toEqual([]);
  });
  it('lays out the strip: a bar per busy hour, a hairline per quiet one', () => {
    const bars = stripBars(day([0, 10, 20]));
    expect(bars).toHaveLength(3);
    expect(bars[0]!.rect).toBeDefined();
    expect(bars[1]!.path).toMatch(/^M/);
    expect(bars[2]!.path).toBeDefined();
    expect(STRIP.W).toBe(240);
    expect(stripBars([])).toEqual([]);
  });
  it('lays out the chart: grid, ticks and bars', () => {
    const buckets = day(Array.from({ length: 24 }, (_, i) => (i % 5 === 0 ? 0 : 30)));
    const m = chartModel(buckets);
    expect(m.max).toBe(30);
    expect(m.grid.map(g => g.label)).toEqual(['0', '15', '30']);
    expect(m.grid[0]!.axis).toBe(true);
    expect(m.bars).toHaveLength(24);
    expect(m.bars.filter(b => b.rect)).toHaveLength(5);
    expect(m.ticks.map(t => t.text)).toEqual(['06:00', '12:00', '18:00']);
    expect(chartX(0, 24)).toBeCloseTo(CH.L + m.slot / 2);
  });
  it('draws a bar path', () => {
    expect(barPath(0, 0, 10, 10, 2)).toBe('M0.00,10.00V2.00Q0.00,0.00 2.00,0.00H8.00Q10.00,0.00 10.00,2.00V10.00Z');
    expect(barPath(0, 0, 2, 10, 5)).toContain('Q0.00,0.00 1.00,0.00');
  });
});
