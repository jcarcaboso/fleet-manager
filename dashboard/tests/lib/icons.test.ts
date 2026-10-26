import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, ICON_SHAPES, iconNames, parseShapes } from '@/lib/icons';
import { glyphSpec } from '@/lib/status';

describe('icon set', () => {
  it('has the names and paths of the old ui set', () => {
    expect(iconNames).toHaveLength(39);
    for (const name of ['search', 'plus', 'sync', 'chevR', 'chevL', 'chevD', 'x', 'check', 'copy', 'terminal', 'file', 'folder', 'key', 'shield', 'lock', 'clock', 'alert', 'info', 'commit', 'branch', 'layers', 'link', 'trash', 'pencil', 'ban', 'activity', 'server', 'spark', 'snooze', 'ack', 'arrowR', 'rocket', 'retry', 'globe', 'list', 'grid', 'logout', 'apple', 'tux']) {
      expect(iconNames).toContain(name);
    }
  });
  it('keeps the exact path data of util.js', () => {
    const old = resolve(process.cwd(), '../server/Fleet.Server/Dashboard/Assets/util.js');
    let src: string | null = null;
    try { src = readFileSync(old, 'utf8'); } catch { /* the old dashboard is removed after the cleanup */ }
    if (!src) return;
    for (const [name, markup] of Object.entries(ICON_PATHS)) {
      expect(src, name).toContain(markup);
    }
  });
  it('parses every icon into shapes', () => {
    for (const name of iconNames) {
      const shapes = ICON_SHAPES[name];
      expect(shapes.length, name).toBeGreaterThan(0);
      expect(shapes.length, name).toBe((ICON_PATHS[name].match(/</g) ?? []).length);
      for (const s of shapes) expect(Object.keys(s.attrs).length).toBeGreaterThan(0);
    }
    expect(parseShapes('<circle cx="1" cy="2" r="3"/><path d="M0 0"/>')).toEqual([{ tag: 'circle', attrs: { cx: '1', cy: '2', r: '3' } }, { tag: 'path', attrs: { d: 'M0 0' } }]);
  });
});

describe('glyphs', () => {
  it('uses a default mark per level and a triangle for warnings', () => {
    expect(glyphSpec('good')).toMatchObject({ kind: 'check', shape: 'disc', fg: '#fff' });
    expect(glyphSpec('warning')).toMatchObject({ kind: 'bang', shape: 'triangle', fg: '#3d2c00' });
    expect(glyphSpec('pending')).toMatchObject({ kind: 'clock', shape: 'ring' });
    expect(glyphSpec('serious').kind).toBe('moon');
    expect(glyphSpec('serious').markFilled).toBe(true);
    expect(glyphSpec('critical', 'x').mark).toBe('M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8');
  });
  it('draws the exclamation mark shorter inside the warning triangle', () => {
    expect(glyphSpec('warning', 'bang').mark).toBe('M8 6.2v3.9M8 12.4v.1');
    expect(glyphSpec('critical', 'bang').mark).toBe('M8 4.4v4.5M8 11.4v.1');
  });
});
