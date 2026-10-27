import { vi } from 'vitest';
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import type { NodeTab } from '@/router';
import { mountApp, textOf, waitFor, type MountOptions, type TestApp } from '../../helpers/app';

/** Fake timers that leave `setImmediate` alone, so `flushPromises` keeps working (see README, "Tests"). */
export const FAKE_TIMERS: { toFake: Array<'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'Date'> } = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] };

export const NODE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Helpers around one mounted machine page. */
export interface NodeTest {
  app: TestApp;
  w(): VueWrapper;
  view(): Element;
  text(sel?: string): string;
  find(sel: string): DOMWrapper<Element>;
  findAll(sel: string): DOMWrapper<Element>[];
  exists(sel: string): boolean;
  click(sel: string): Promise<void>;
  toasts(): string;
  hero(): string;
  panel(): string;
  /** The tab links of the page. */
  tabs(): DOMWrapper<Element>[];
  tabText(label: string): string;
  /** All requests of one kind. */
  posts(pattern?: RegExp): TestApp['mock']['calls'];
  gets(pattern: RegExp): TestApp['mock']['calls'];
  go(path: string): Promise<void>;
  /** Waits until the machine page of `alias` is on screen. */
  ready(alias?: string): Promise<void>;
  /** Waits until a tab is current and its panel shows `text`. */
  until(check: () => unknown, label?: string): Promise<void>;
  unmount(): void;
}

export const sleep = (ms: number): Promise<void> => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms).then(() => undefined) : new Promise(r => setTimeout(r, ms)));

/** Mounts the machine page for `path` (for example `/machines/studio-mini/problems`) against a fresh mock and waits for the header. */
export async function openNode(path: string, mock: MountOptions['mock'] = {}, opts: { wait?: boolean } = {}): Promise<NodeTest> {
  const app = await mountApp({ path, mock });
  const t = nodeTest(app);
  if (opts.wait !== false) await t.ready();
  return t;
}

export function nodeTest(app: TestApp): NodeTest {
  const t: NodeTest = {
    app,
    w: () => app.wrapper,
    view: () => app.wrapper.find('#view').element,
    text: (sel = '#view') => textOf(app.wrapper.find(sel).element),
    find: sel => app.wrapper.find(sel),
    findAll: sel => app.wrapper.findAll(sel),
    exists: sel => app.wrapper.find(sel).exists(),
    click: async sel => { await app.wrapper.find(sel).trigger('click'); await app.settle(); },
    toasts: () => textOf(app.wrapper.find('#toasts').element),
    hero: () => textOf(app.wrapper.find('.nhero').element),
    panel: () => textOf(app.wrapper.find('#tabpanel').element),
    tabs: () => app.wrapper.findAll('nav.tabs a'),
    tabText: label => textOf(app.wrapper.findAll('nav.tabs a').find(a => a.text().startsWith(label))?.element),
    posts: (pattern = /./) => app.mock.calls.filter(c => c.method === 'POST' && pattern.test(c.path)),
    gets: pattern => app.mock.calls.filter(c => c.method === 'GET' && pattern.test(c.path)),
    go: path => app.go(path),
    ready: async alias => { await waitFor(() => app.wrapper.find('.nhero h1').exists() && (!alias || app.wrapper.find('.nhero h1').text() === alias), { label: `machine page ${alias ?? ''}` }); await app.settle(); },
    until: async (check, label = 'condition') => { await waitFor(check, { label }); },
    unmount: () => app.unmount(),
  };
  return t;
}

export const currentTab = (t: NodeTest): string => t.find('nav.tabs a[aria-current]').text().replace(/\d+$/, '').trim();
export const TABS: NodeTab[] = ['overview', 'installed', 'problems', 'activity', 'security', 'settings'];

/** A `<dl>` row by its label: `{ Hostname: 'studio-mini.lan', … }`. */
export function kv(t: NodeTest, label: string, scope = '#machine-panel'): string | null {
  const dt = t.findAll(`${scope} dt`).find(x => x.text() === label);
  return dt ? textOf(dt.element.nextElementSibling) : null;
}

/** Looks for text that must never reach the screen (a missing value rendered as a word). */
export const stray = (text: string): string[] => text.match(/undefined|\bnull\b|NaN|Invalid Date|\[object/g) ?? [];

/** The element that holds the focus, as a short description. */
export const focused = (): string => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}` : 'none'; };

/**
 * Changes what `GET nodes/{alias}` answers for one machine (a record the mock never produces, such as no Targets or no credential).
 * Install it before the page loads: open another page first, spy, then navigate.
 */
export function patchNodeResponse(t: NodeTest, alias: string, change: (detail: Record<string, any>) => void): void {
  const real = t.app.ctx.api.get.bind(t.app.ctx.api) as (...a: unknown[]) => Promise<unknown>;
  vi.spyOn(t.app.ctx.api, 'get').mockImplementation(((path: string, ...rest: unknown[]) => real(path, ...rest).then(r => {
    if (path === `nodes/${alias}`) change(r as Record<string, any>);
    return r;
  })) as typeof t.app.ctx.api.get);
}
