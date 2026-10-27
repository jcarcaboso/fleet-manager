/** The icon set of the dashboard: 24x24 stroke icons, the exact paths of `ic` in ui.js (as inner SVG markup). `Icon.vue` renders them. */
export const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.6-4.4L4 8.5"/><path d="M4 3.5v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.4l1.4-1.9"/><path d="M20 20.5v-5h-5"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  chevL: '<path d="M15 6l-6 6 6 6"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  branch: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="7.5" r="2.5"/><path d="M6 8v8M18 10c0 4-5 4.5-10.5 7"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  snooze: '<circle cx="12" cy="13" r="8"/><path d="M9.5 10h5l-5 6h5M5 3L2 6M19 3l3 3"/>',
  ack: '<path d="M20 6L9 17l-5-5"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  rocket: '<path d="M12 15l-3-3c1.5-5 5-8.5 11-9-0.5 6-4 9.5-8 12z"/><path d="M9 12H5l2.5-3.5H11M12 15v4l3.5-2.5V13"/><path d="M6.5 16.5c-1.5.5-2.5 2-2.5 3.5 1.5 0 3-1 3.5-2.5"/>',
  retry: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 3.5v5h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 8l4 4-4 4M20 12H9"/>',
  apple:
    '<path d="M15.5 3.5c-1 .1-2.2.8-2.8 1.7-.6.7-1 1.8-.9 2.8 1.1 0 2.2-.7 2.8-1.6.6-.8 1-1.9.9-2.9z"/><path d="M12 8.5c-1 0-2.3-.8-3.5-.8C6.3 7.7 4.5 9.6 4.5 12.6c0 3.6 2.6 7.9 4.6 7.9 1 0 1.6-.6 2.9-.6s1.8.6 2.9.6c2.1 0 4.1-4 4.6-5.5-2.4-1-2.9-4.9-.3-6.3-1-1.3-2.4-1.9-3.7-1.9-1.4 0-2.4.7-3.5.7z"/>',
  tux: '<path d="M12 3c-2.3 0-3.5 1.9-3.5 4.4 0 1.6-.6 2.8-1.7 4.4-1.3 1.9-2.3 3.9-2 6 .2 1.2 1.6 1.9 3.2 2.2h8c1.6-.3 3-1 3.2-2.2.3-2.1-.7-4.1-2-6-1.1-1.6-1.7-2.8-1.7-4.4C15.5 4.9 14.3 3 12 3z"/><path d="M10.5 8h.01M13.5 8h.01M11 10.2c.6.4 1.4.4 2 0"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;
export const iconNames = Object.keys(ICON_PATHS) as IconName[];

export interface Shape {
  tag: 'circle' | 'path' | 'rect';
  attrs: Record<string, string>;
}
const SHAPE_RE = /<(circle|path|rect)\b([^>]*?)\/>/g;
const ATTR_RE = /([a-z-]+)="([^"]*)"/g;

/** Parses the static markup above into shapes, so components render elements instead of injecting markup. */
export function parseShapes(markup: string): Shape[] {
  const shapes: Shape[] = [];
  for (const m of markup.matchAll(SHAPE_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(ATTR_RE)) attrs[a[1] as string] = a[2] as string;
    shapes.push({ tag: m[1] as Shape['tag'], attrs });
  }
  return shapes;
}
export const ICON_SHAPES: Record<IconName, Shape[]> = Object.fromEntries(
  iconNames.map(name => [name, parseShapes(ICON_PATHS[name])]),
) as Record<IconName, Shape[]>;
