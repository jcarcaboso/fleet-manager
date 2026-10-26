/**
 * Status glyphs and pills (ported from util.js). A glyph is a filled shape that carries the colour plus an inner
 * mark that carries the meaning, so colour is never the only signal; every status in the UI shows icon plus label.
 */

export type GlyphLevel = 'good' | 'info' | 'warning' | 'serious' | 'critical' | 'neutral' | 'pending';
export type GlyphKind = 'check' | 'x' | 'bang' | 'info' | 'moon' | 'clock' | 'sync' | 'minus' | 'down' | 'ban';

const COLORS: Record<GlyphLevel, string> = {
  good: '#0ca30c',
  info: '#3577e6',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
  neutral: '#9a958c',
  pending: '#a9a397',
};
const DEFAULT_KIND: Record<GlyphLevel, GlyphKind> = {
  good: 'check',
  info: 'sync',
  warning: 'bang',
  serious: 'moon',
  critical: 'bang',
  neutral: 'minus',
  pending: 'clock',
};

export interface GlyphSpec {
  level: GlyphLevel;
  kind: GlyphKind;
  /** The fill colour of the shape. */
  color: string;
  /** The stroke colour of the inner mark. */
  fg: string;
  shape: 'triangle' | 'ring' | 'disc';
  /** Inner SVG markup of the mark (static paths only). */
  mark: string;
  /** Whether the mark is a filled shape (the moon) instead of a stroke. */
  markFilled: boolean;
}

/** The path (or circle) markup of each mark. The `bang` mark is shorter inside the warning triangle. */
function markFor(level: GlyphLevel, kind: GlyphKind): string {
  switch (kind) {
    case 'check': return 'M4.7 8.3l2.2 2.2 4.5-4.6';
    case 'x': return 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8';
    case 'bang': return level === 'warning' ? 'M8 6.2v3.9M8 12.4v.1' : 'M8 4.4v4.5M8 11.4v.1';
    case 'info': return 'M8 7.4v4.2M8 4.8v.1';
    case 'moon': return 'M10.9 9.7A3.7 3.7 0 0 1 6.3 5.1a3.7 3.7 0 1 0 4.6 4.6z';
    case 'clock': return 'M8 4.9v3.3l2.1 1.3';
    case 'sync': return 'M4.9 7a3.2 3.2 0 0 1 5.8-1.2M11.1 9a3.2 3.2 0 0 1-5.8 1.2M10.9 3.9v2.1H8.8M5.1 12.1V10h2.1';
    case 'minus': return 'M5 8h6';
    case 'down': return 'M8 4.3v5.6M5.8 7.8L8 10l2.2-2.2M5 12h6';
    case 'ban': return 'M5.3 10.7l5.4-5.4';
  }
}

export function glyphSpec(level: GlyphLevel, kind?: GlyphKind): GlyphSpec {
  const color = COLORS[level] ?? COLORS.neutral;
  const k = kind ?? DEFAULT_KIND[level] ?? 'minus';
  return {
    level,
    kind: k,
    color,
    fg: level === 'warning' ? '#3d2c00' : level === 'pending' ? '#6f695f' : '#fff',
    shape: level === 'warning' ? 'triangle' : level === 'pending' ? 'ring' : 'disc',
    mark: markFor(level, k),
    markFilled: k === 'moon',
  };
}

/** A level, kind and label: what a status chip shows. */
export interface StatusMeta {
  level: GlyphLevel;
  kind: GlyphKind;
  label: string;
}
