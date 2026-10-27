/**
 * Keyboard focus after the actions that load a page again (Refresh, Try again, Check again, Sync). The button that was pressed may be
 * replaced by the loading state; focus must not fall to <body>: it moves to the page heading (as after a navigation) or stays on the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp, waitFor, type TestApp } from '../helpers/app';
import { installIntersectionObserver } from '../views/machines/ioDouble';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const REV = 'a3f9c21';
const view = (): HTMLElement => document.getElementById('view')!;
const idle = async (): Promise<void> => { await app!.settle(); await waitFor(() => !document.querySelector('#view .skel')); await app!.settle(); };

/** Focuses the button like a keyboard user, presses it, waits for the page, and describes where focus is now. */
async function press(selector: string): Promise<HTMLElement> {
  const button = document.querySelector<HTMLElement>(selector);
  expect(button, `the button ${selector}`).not.toBeNull();
  button!.focus();
  expect(document.activeElement).toBe(button);
  button!.click();
  await idle();
  return document.activeElement as HTMLElement;
}
const notBody = (el: Element | null): void => {
  expect(el, 'something has the focus').not.toBeNull();
  expect(el, 'the focus did not fall to <body>').not.toBe(document.body);
  expect(view().contains(el), `focus is on the page (${el?.tagName})`).toBe(true);
};
const isHeading = (el: Element | null): void => {
  notBody(el);
  expect(el!.tagName).toBe('H1');
};

describe('Refresh and Check again put the focus on the page heading', () => {
  it.each([
    ['Audit: Refresh', '/audit', '[data-act=reload]'],
    ['Deployments: Refresh', '/deployments', '[data-act=reload]'],
    ['Problems: Check again', '/problems', '[data-act=reload]'],
  ])('%s', async (_name, path, selector) => {
    app = await mountApp({ path });
    await idle();
    const after = await press(selector);
    isHeading(after);
  });
});

describe('Try again puts the focus on the page heading', () => {
  const REVISION = '/deployments/' + 'REVISION_ID';
  it.each([
    ['Machines', '/machines', { fail: 'nodes' }],
    ['Problems', '/problems', { fail: 'issues' }],
    ['Deployments', '/deployments', { fail: 'desired-revisions' }],
    ['Repository', '/repository', { fail: 'source' }],
    ['Models', '/models', { fail: 'cliproxy' }],
    ['Enrollment', '/enrollment', { fail: 'enrollment-links' }],
    ['Audit', '/audit', { fail: 'audit' }],
    ['a machine', '/machines/studio-mini', { fail: 'nodes/studio-mini' }],
    ['a revision', REVISION, { fail: 'desired-revisions/' }],
  ])('%s', async (_name, path, mock) => {
    installIntersectionObserver(() => false);
    app = await mountApp({ path: '/machines', mock });
    const target = path.replace('REVISION_ID', app.mock.data.revisions[0]!.id);
    if (target !== '/machines') await app.go(target);
    await waitFor(() => document.querySelector('#view .empty--error'));
    app.mock.options.fail = null;
    const after = await press('#view .empty--error button');
    isHeading(after);
    expect(document.querySelector('#view .empty--error')).toBeNull();
  });

  it('the rollout of a revision that failed to load', async () => {
    app = await mountApp({ path: '/machines', mock: { fail: 'rollouts/' } });
    await app.go('/deployments/' + app.mock.data.revisions[0]!.id);
    await waitFor(() => document.querySelector('#view [data-act=reload]'));
    app.mock.options.fail = null;
    const after = await press('#view [data-act=reload]');
    isHeading(after);
    expect(document.querySelector('#view [data-act=reload]')).toBeNull();
  });

  it('the dashboard itself when the Server could not be reached at start-up', async () => {
    app = await mountApp({ path: '/machines', mock: { offline: true } });
    await waitFor(() => document.querySelector('#view .empty-retry button'));
    app.mock.options.offline = false;
    const after = await press('#view .empty-retry button');
    await waitFor(() => document.querySelector('#view .card, #view .health'));
    isHeading(document.activeElement);
    expect(after).not.toBe(document.body);
  });
});

describe('actions that keep the page keep the focus on it', () => {
  it.each([
    ['Repository', '/repository'],
    ['Problems', '/problems'],
    ['Machines', '/machines'],
  ])('Sync repository on %s', async (_name, path) => {
    installIntersectionObserver(() => false);
    app = await mountApp({ path });
    await idle();
    const after = await press('#view [data-act=sync]');
    notBody(after);
  });

  it('Refresh models', async () => {
    app = await mountApp({ path: '/models' });
    await idle();
    notBody(await press('#view [data-act=refresh-models]'));
  });

  it('Refresh disk usage on a machine', async () => {
    app = await mountApp({ path: '/machines/studio-mini' });
    await idle();
    const after = await press('#view [data-act=disk-refresh]');
    notBody(after);
  });
});

describe('a navigation moves the focus to the heading as before', () => {
  it(`opening a revision (${REV})`, async () => {
    app = await mountApp({ path: '/deployments' });
    await app.go('/deployments/' + app.mock.data.revisions[0]!.id);
    await waitFor(() => document.querySelector('#view h1.dep-title'));
    isHeading(document.activeElement);
  });
});
