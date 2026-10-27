/**
 * The Enrollment page against the mock API: the links list and its filter, the create form (which starts the wizard), revocation, and the
 * loading, empty, error and scope states. Ports of the old drive.js scenarios revokeLink, linkRevokeStale and the page part of scopeRead.
 */
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textOf, waitFor, type TestApp } from '../../helpers/app';
import { $, $$, advance, click, openApp, submit, type } from './helpers';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });
const open = async (mock = {}): Promise<TestApp> => {
  app = await openApp({ path: '/enrollment', mock });
  return app;
};
const rows = (): string[] => $$('.link-row').map(r => r.querySelector('b')!.textContent!);

describe('links list', () => {
  it('lists every link newest expiry first, with its state word, glyph and detail', async () => {
    await open();
    expect($('h1')!.textContent).toBe('Enrollment');
    expect(rows()).toEqual(['lab-vm-08', 'lab-vm-07', 'tablet-test', 'guest-mbp']);
    const [active, used, expired, revoked] = $$('.link-row');
    expect(active!.className).toContain('link-row--active');
    expect(active!.querySelector('.pill')!.textContent).toBe('Active');
    expect(active!.querySelector('.pill svg.g')).not.toBeNull();
    expect(textOf(active!.querySelector('.link-state .small'))).toMatch(/^Expires in \d+ min · \d\d:\d\d UTC$/);
    expect(textOf(active!.querySelector('.link-main .small'))).toMatch(/^Expiry [A-Z][a-z]{2} \d+, \d\d:\d\d UTC$/);
    expect(textOf(used!.querySelector('.link-state .small'))).toMatch(/^Used .* ago · enrolled lab-vm-07/);
    expect(textOf(expired!.querySelector('.link-state .small'))).toMatch(/^Expired .*, never used/);
    expect(textOf(revoked!.querySelector('.link-state .small'))).toMatch(/^Revoked .* by joan/);
    expect($$('.link-row .pill').map(p => p.textContent)).toEqual(['Active', 'Used', 'Expired', 'Revoked']);
  });

  it('active links count down, used links open the machine', async () => {
    await open();
    const before = textOf($('.link-row--active .link-state .small'));
    await advance(61_000);
    expect(textOf($('.link-row--active .link-state .small'))).not.toBe(before);
    const open1 = $<HTMLAnchorElement>('.link-row--consumed .link-act a')!;
    expect(open1.textContent).toBe('Open machine');
    expect(open1.getAttribute('href')).toMatch(/^\/machines\/[0-9a-f-]{36}$/);
  });

  it('filters by state with counts, and says when nothing is in a state', async () => {
    await open();
    expect($$('.chips-filter button').map(b => textOf(b))).toEqual(['All4', 'Active1', 'Used1', 'Expired1', 'Revoked1']);
    expect($('.chips-filter [aria-pressed=true]')!.textContent).toContain('All');
    await click($$('.chips-filter button')[3]!);
    expect(rows()).toEqual(['tablet-test']);
    await click($$('.chips-filter button')[1]!);
    expect(rows()).toEqual(['lab-vm-08']);
    await click($$('.chips-filter button')[0]!);
    expect(rows()).toHaveLength(4);
  });

  it('with no links says so', async () => {
    await open({ empty: true });
    expect(rows()).toEqual([]);
    expect($('.empty-mini p')!.textContent).toBe('No enrollment links yet.');
  });

  it('says which kind is missing when a filter has nothing', async () => {
    await open();
    app!.mock.links.splice(0, app!.mock.links.length, ...app!.mock.links.filter(l => l.state !== 'consumed'));
    await app!.go('/audit');
    await app!.go('/enrollment');
    await waitFor(() => $('.link-row'));
    await click($$('.chips-filter button')[2]!);
    expect($('.empty-mini p')!.textContent).toBe('No used links.');
  });

  it('notes when only the newest links are shown', async () => {
    await open({ pageSize: 1 });
    expect(rows()).toHaveLength(3);
    expect($$('.panel > p.muted.small').pop()!.textContent).toBe('Showing the newest links only.');
  });

  it('shows the loading skeleton, then an error with Try again that loads again', async () => {
    await open({ fail: 'enrollment-links' });
    expect($('.empty--error h1')!.textContent).toBe('Could not load Enrollment');
    expect($('.link-row')).toBeNull();
    app!.mock.options.fail = null;
    await click($('.empty--error button'));
    await waitFor(() => $('.link-row'));
    expect($('.empty--error')).toBeNull();
  });
});

describe('scope', () => {
  it('a read token sees disabled inputs, a locked Add machine and Create link, a lock note, and no revoke button that works (scopeRead)', async () => {
    await open({ scope: 'read' });
    expect($<HTMLInputElement>('#en-alias')!.disabled).toBe(true);
    expect($<HTMLSelectElement>('#en-exp')!.disabled).toBe(true);
    const locked = $$('.is-locked');
    expect(locked.length).toBeGreaterThanOrEqual(3); // Add machine, Create link, Revoke
    expect(locked.every(b => b.getAttribute('aria-disabled') === 'true' && !!b.dataset.tip)).toBe(true);
    expect(textOf($('.page-head + .lock-note'))).toBe('Needs the admin scope. Your token has read access.');
    await click(locked[0]!);
    expect($('.toast')!.textContent).toMatch(/Needs the admin scope/);
    await click(locked[locked.length - 1]!);
    expect(app!.mock.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    expect(app!.ctx.wizard.open).toBe(false);
  });

  it('an operate token cannot create or revoke either', async () => {
    await open({ scope: 'operate' });
    expect($<HTMLInputElement>('#en-alias')!.disabled).toBe(true);
    expect($$('.is-locked').length).toBeGreaterThanOrEqual(3);
  });

  it('an admin has working controls and no lock note', async () => {
    await open();
    expect($('.lock-note')).toBeNull();
    expect($('.is-locked')).toBeNull();
    expect($<HTMLInputElement>('#en-alias')!.disabled).toBe(false);
  });
});

describe('create form', () => {
  it('rejects a blank alias inline, marks the field invalid, focuses it, and starts nothing', async () => {
    await open();
    expect($('#en-msg')!.textContent).toBe('The guided setup shows the install and enroll commands next.');
    await submit($('form.form'));
    expect($('#en-msg')!.textContent).toBe('Choose a nonblank alias of at most 200 characters.');
    expect($('#en-msg')!.classList.contains('is-err')).toBe(true);
    expect($('#en-alias')!.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe($('#en-alias'));
    expect(app!.ctx.wizard.open).toBe(false);
    expect(app!.mock.calls.filter(c => c.method === 'POST')).toHaveLength(0);
    type($<HTMLInputElement>('#en-alias'), 'x'.repeat(201));
    await submit($('form.form'));
    expect($('#en-msg')!.textContent).toBe('Choose a nonblank alias of at most 200 characters.');
    expect(app!.mock.calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });

  it('opens the wizard with the alias and the chosen expiry and creates the link at once', async () => {
    await open();
    type($<HTMLInputElement>('#en-alias'), '  office-mini ');
    $<HTMLSelectElement>('#en-exp')!.value = '1800';
    $('#en-exp')!.dispatchEvent(new Event('change', { bubbles: true }));
    await submit($('form.form'));
    await waitFor(() => $('.wz-link'));
    const post = app!.mock.calls.find(c => c.method === 'POST' && c.path === 'enrollment-links')!;
    expect(post.body).toEqual({ alias: 'office-mini', expiresInSeconds: 1800 });
    expect($('.modal h2')!.textContent).toBe('Install the Agent and enroll');
    expect($('.wz-link-top')!.textContent).toContain('office-mini');
  });

  it('the Add machine button of the page opens the wizard empty', async () => {
    await open();
    await click($$('.page-head .btn-primary')[0]!);
    expect($('.modal h2')!.textContent).toBe('Name your new machine');
    expect($<HTMLInputElement>('#wz-alias')!.value).toBe('');
  });

  it('explains a creation that failed, in the wizard and on the form after it closes', async () => {
    await open({ forbid: true });
    type($<HTMLInputElement>('#en-alias'), 'office-mini');
    await submit($('form.form'));
    await waitFor(() => $('#wz-alias-msg')?.classList.contains('is-err'));
    expect($('#wz-alias-msg')!.textContent).toMatch(/scope/i);
    expect($('.wz-link')).toBeNull();
    await click($('.modal [data-act=modal-close]'));
    expect($('.modal')).toBeNull();
    expect($('#en-msg')!.classList.contains('is-err')).toBe(true);
    expect($('#en-msg')!.textContent).toMatch(/scope/i);
  });
});

describe('revoking a link', () => {
  it('revokes an active link, disables its button meanwhile, toasts and shows it as revoked (revokeLink)', async () => {
    await open();
    const btn = $<HTMLButtonElement>('.link-row--active .link-act button')!;
    expect(btn.textContent).toBe('Revoke');
    btn.click();
    await flushPromises();
    expect(btn.disabled).toBe(true);
    await waitFor(() => /Enrollment link revoked/.test($('.toast')?.textContent ?? ''));
    await waitFor(() => $('.link-row--revoked .link-state')?.textContent?.includes('Revoked'));
    expect(rows().length).toBe(4);
    expect($$('.link-row--revoked')).toHaveLength(2);
    expect($('.link-row--active')).toBeNull();
    const post = app!.mock.calls.find(c => c.method === 'POST')!;
    expect(post.path).toMatch(/^enrollment-links\/[0-9a-f-]{36}\/revoke$/);
  });

  it('a revocation that fails says why, enables the button again and reloads the list', async () => {
    await open({ forbid: true });
    const btn = $<HTMLButtonElement>('.link-row--active .link-act button')!;
    await click(btn);
    await waitFor(() => $('.toast--warning, .toast--critical'));
    expect($('.toast')!.textContent).toContain('Link was not revoked');
    expect($('.toast')!.textContent).toMatch(/scope/i);
    expect(btn.disabled).toBe(false);
    expect($('.link-row--active')).not.toBeNull();
  });

  it('a revocation that answers after the user left still toasts, and reloads nothing on the page the user is on (linkRevokeStale)', async () => {
    await open({ lag: { revoke: 3000 } });
    await click($('.link-row--active .link-act button'));
    await advance(300);
    await app!.go('/audit');
    await waitFor(() => $('h1')?.textContent === 'Audit' && !$('.skel'));
    const calls = app!.mock.calls.length;
    const page = $('#view')!.firstElementChild;
    await advance(3600);
    expect($('#view')!.firstElementChild).toBe(page);
    expect(/revoked/i.test($('.toast')?.textContent ?? '')).toBe(true);
    expect(app!.mock.calls.slice(calls).filter(c => c.method === 'GET' && c.path.startsWith('enrollment-links'))).toHaveLength(0);
    expect(app!.mock.links.some(l => !!l.revokedAt && l.alias === 'lab-vm-08')).toBe(true);
  });

  it('a session that ended sends the visitor to sign-in with a notice', async () => {
    await open();
    app!.mock.state.signedIn = false;
    await click($('.link-row--active .link-act button'));
    await waitFor(() => app!.router.currentRoute.value.name === 'login');
    // The login view is loaded lazily, so wait for its text rather than a fixed number of ticks.
    await waitFor(() => /session ended/i.test(document.body.textContent ?? ''));
    expect(document.body.textContent).toMatch(/session ended/i);
  });
});
