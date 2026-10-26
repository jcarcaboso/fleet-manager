/**
 * The Add machine wizard against the mock API, with fake timers for the polling. Ports of the old drive.js scenarios wizard, wizardStep2,
 * wizardStep3, wizardExpiry, wizardClose, wizardRoute, wizardStalled, wizardDone, wizardFailReads, wizardHang, wizardStalledFail,
 * wizardStaleCreate and wizardStaleCreateError, plus keyboard, scope and focus behaviour.
 */
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textOf, waitFor, type TestApp } from '../../helpers/app';
import { $, $$, addButton, advance, click, linkReads, modalText, nodeReads, openApp, submit, toStep2, toStep3, type } from './helpers';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });
const open = async (mock = {}, path = '/enrollment'): Promise<TestApp> => {
  app = await openApp({ path, mock });
  return app;
};
const idReads = (): number => linkReads(app!);
const closeWizard = (): Promise<void> => click($('.modal .icon-btn'));
const title = (): string => $('.modal h2')!.textContent!;

describe('the whole flow (wizard, wizardDone)', () => {
  it('rejects a blank alias, creates a link, shows it once, detects the enrollment and the first check-in, and forgets the link on close', async () => {
    await open({ pagesize: 1 }, '/machines');
    await click(addButton());
    await waitFor(() => $('#wz-alias'));
    expect(title()).toBe('Name your new machine');
    expect($('.modal .eyebrow')!.textContent).toBe('Add machine · step 1 of 3');
    expect(document.activeElement).toBe($('#wz-alias'));
    await submit($('form[data-form=wz]'));
    expect($('#wz-alias-msg')!.textContent).toMatch(/nonblank/);
    expect($('#wz-alias-msg')!.classList.contains('is-err')).toBe(true);
    expect($('#wz-alias')!.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe($('#wz-alias'));
    type($<HTMLInputElement>('#wz-alias'), 'office-mini');
    await flushPromises();
    expect($('#wz-alias')!.getAttribute('aria-invalid')).toBe('false');
    expect($('#wz-alias-msg')!.textContent).toMatch(/Lowercase letters/);
    await submit($('form[data-form=wz]'));
    await waitFor(() => $('.wz-link'));

    expect(title()).toBe('Install the Agent and enroll');
    expect($('.cmd--link code')!.textContent).toMatch(/\/enroll#fleet-v1=/);
    expect($('.wz-link-top')!.textContent).toMatch(/One-time enrollment link for office-mini.*Expires in 1[45]:\d\d/);
    expect($('.toast')!.textContent).toContain('Enrollment link created');
    expect($('.toast')!.textContent).toMatch(/Valid until \d\d:\d\d UTC\./);

    await click($('[data-act=wz-wait]'));
    expect($('.wz-3')).not.toBeNull();
    expect(title()).toBe('Waiting for office-mini to check in');
    expect($('.wz-wait .lead')!.textContent).toContain('Fleet is listening for office-mini');
    await advance(6500);
    await waitFor(() => $('.wz-checks li:nth-child(2)')?.classList.contains('done'));
    expect($('.wz-checks li:nth-child(2)')!.textContent).toBe('Agent enrolled and the link was used');
    await advance(5000);
    await waitFor(() => /is online/.test(title()));
    expect(title()).toBe('office-mini is online');
    expect($('.wz-wait .pill')!.textContent).toBe('Checked in');
    expect($('.wz-wait')!.textContent).toContain('macOS');
    expect($('.wz-checks li:nth-child(3)')!.textContent).toMatch(/^First check-in received \d\d:\d\d UTC$/);
    expect($('.wz-art--big')!.classList.contains('is-online')).toBe(true);
    expect($$('.toast').map(t => t.textContent).join('|')).toContain('office-mini checked in');
    expect($$('.wz-steps li').map(l => l.className)).toEqual(['done', 'done', 'done']);

    const polls = (): number => idReads() + nodeReads(app!, 'office-mini');
    const n = polls();
    await advance(10_000);
    expect(polls()).toBe(n); // polling stopped once the Node was found

    await closeWizard();
    expect($('.modal')).toBeNull();
    expect(document.body.textContent).not.toContain('fleet-v1=');
    expect(app!.ctx.wizard.open).toBe(false);
    await advance(100);
    await waitFor(() => !!$$('.card h3').find(h => h.textContent === 'office-mini'));
  });

  it('keeps the step list, the heading and the eyebrow in step', async () => {
    await open();
    await click(addButton());
    expect($$('.wz-steps li').map(l => l.className)).toEqual(['cur', '', '']);
    type($<HTMLInputElement>('#wz-alias'), 'office-mini');
    await submit($('form[data-form=wz]'));
    await waitFor(() => $('.wz-link'));
    expect($('.modal .eyebrow')!.textContent).toBe('Add machine · step 2 of 3');
    expect($$('.wz-steps li').map(l => l.className)).toEqual(['done', 'cur', '']);
    expect($$('.wz-steps li')[0]!.querySelector('svg.g')).not.toBeNull();
    expect($('.modal')!.getAttribute('aria-labelledby')).toBe($('.modal h2')!.id);
    expect($('.modal')!.getAttribute('aria-modal')).toBe('true');
  });

  it('uses the platform and expiry chosen in step 1, and the preview follows the platform', async () => {
    await open({ platform: 'linux' });
    await click(addButton());
    const art = $('#wz-art svg.dev')!;
    expect(art.getAttribute('aria-label')).toBe('macOS machine, has not checked in yet');
    $<HTMLInputElement>('input[name=wz-plat][value=linux]')!.click();
    await flushPromises();
    expect($('#wz-art svg.dev')!.getAttribute('aria-label')).toBe('Linux machine, has not checked in yet');
    $<HTMLInputElement>('input[name=wz-exp][value="3600"]')!.click();
    await flushPromises();
    type($<HTMLInputElement>('#wz-alias'), 'box');
    await submit($('form[data-form=wz]'));
    await waitFor(() => $('.wz-link'));
    expect(app!.mock.calls.find(c => c.method === 'POST')!.body).toEqual({ alias: 'box', expiresInSeconds: 3600 });
    expect($('#os-linux')!.getAttribute('aria-selected')).toBe('true');
    expect($('.wz-link-top')!.textContent).toMatch(/Expires in (59|60):\d\d/);
  });

  it('trims the alias, and refuses one over 200 characters without a request', async () => {
    await open();
    await click(addButton());
    type($<HTMLInputElement>('#wz-alias'), 'x'.repeat(201));
    await submit($('form[data-form=wz]'));
    expect($('#wz-alias-msg')!.textContent).toBe('Choose a nonblank alias of at most 200 characters.');
    expect(app!.mock.calls.filter(c => c.method === 'POST')).toHaveLength(0);
    type($<HTMLInputElement>('#wz-alias'), '  spaced  ');
    await submit($('form[data-form=wz]'));
    await waitFor(() => $('.wz-link'));
    expect(app!.mock.calls.find(c => c.method === 'POST')!.body).toMatchObject({ alias: 'spaced' });
  });
});

describe('step 2: the commands', () => {
  it('shows the link once with a copy button, the macOS commands, and never puts the alias or the link into a command', async () => {
    await open();
    await toStep2('weird; rm -rf $HOME');
    const cmds = $$('.os-panel .cmd code').map(c => c.textContent!);
    expect(cmds).toEqual([
      'brew tap jcarcaboso/fleet https://github.com/jcarcaboso/fleet-manager\nbrew install jcarcaboso/fleet/fleet-agent',
      'agent_bin="$(brew --prefix jcarcaboso/fleet/fleet-agent)/bin/fleet-agent"\n"$agent_bin" enroll --link',
      'brew services start jcarcaboso/fleet/fleet-agent',
    ]);
    expect(cmds.join('\n')).not.toContain('weird');
    expect(cmds.join('\n')).not.toContain('fleet-v1');
    expect($('.os-panel')!.textContent).toContain('macOS 13 or newer, Apple silicon or Intel');
    expect($('.cmd--link .copy span')!.textContent).toBe('Copy link');
    expect($('.cmd--link .copy')!.getAttribute('data-copy')).toMatch(/\/enroll#fleet-v1=/);
    expect($('.wz-link')!.textContent).toContain('Anyone with this link can enroll weird; rm -rf $HOME until it expires or is used.');
    expect($('.wz-meter span')).not.toBeNull();
    expect($('.wz-foot .btn-danger-ghost')!.textContent).toBe('Revoke link');
  });

  it('switches to Linux with the tab buttons and the arrow keys, keeping the tab pattern', async () => {
    await open();
    await toStep2('box');
    expect($$('.os-tabs [role=tab]').map(t => [t.getAttribute('aria-selected'), t.getAttribute('tabindex')])).toEqual([['true', '0'], ['false', '-1']]);
    await click($('#os-linux'));
    expect($('#os-linux')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe($('#os-linux'));
    expect($('#os-panel')!.getAttribute('aria-labelledby')).toBe('os-linux');
    expect($('.os-panel')!.textContent).toContain('on Linux amd64');
    expect($('.os-panel')!.textContent).toContain('It runs under systemd --user.');
    expect($('.os-panel .steps li.is-or .sn')!.textContent).toBe('or');
    expect($$('.os-panel .cmd code').pop()!.textContent).toBe('sudo loginctl enable-linger "$USER"');
    $('#os-linux')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flushPromises();
    expect($('#os-macos')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe($('#os-macos'));
    $('#os-macos')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect($('#os-linux')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe($('#os-linux'));
  });

  it('revokes the link from the dialog: toast, the dialog closes, the link is revoked on the Server', async () => {
    await open();
    await toStep2('office-mini');
    const id = app!.mock.links.find(l => l.alias === 'office-mini')!.id;
    await click($('.wz-foot [data-act=revoke-link]'));
    await waitFor(() => !$('.modal'));
    expect($$('.toast').map(t => t.textContent).join('|')).toContain('Enrollment link revoked');
    expect(app!.mock.calls.some(c => c.method === 'POST' && c.path === `enrollment-links/${id}/revoke`)).toBe(true);
    await waitFor(() => $$('.link-row--revoked').some(r => r.textContent!.includes('office-mini')));
  });

  it('a revocation that is refused says why and keeps the dialog', async () => {
    await open();
    await toStep2('office-mini');
    app!.mock.options.forbid = true;
    const btn = $<HTMLButtonElement>('.wz-foot [data-act=revoke-link]')!;
    await click(btn);
    await waitFor(() => $('.toast--warning'));
    expect($('.toast--warning')!.textContent).toContain('Link was not revoked');
    expect($('.modal')).not.toBeNull();
    expect(btn.disabled).toBe(false);
  });
});

describe('step 3: waiting', () => {
  it('Show commands goes back and stops polling; I have run these commands starts again', async () => {
    await open({ enroll: false });
    await toStep3('office-mini');
    await advance(1300);
    expect(idReads()).toBe(1);
    await click($('[data-act=wz-back]'));
    expect(title()).toBe('Install the Agent and enroll');
    const n = idReads();
    await advance(20_000);
    expect(idReads()).toBe(n);
    await click($('[data-act=wz-wait]'));
    await advance(1300);
    expect(idReads()).toBe(n + 1);
  });

  it('shows the elapsed time while waiting and the "checking every few seconds" note', async () => {
    await open({ enroll: false });
    await toStep3('office-mini');
    expect($('.wz-wait .muted.small')!.textContent).toBe('Waiting 0:00 · checking every few seconds');
    await advance(5000);
    expect($('.wz-wait .muted.small')!.textContent).toBe('Waiting 0:05 · checking every few seconds');
  });

  it('View machine opens it and closes the dialog; Add another starts a fresh wizard', async () => {
    await open();
    await toStep3('office-mini');
    await advance(12_000);
    await waitFor(() => /is online/.test(title()));
    const view = $<HTMLAnchorElement>('[data-act=wz-view]')!;
    expect(view.textContent).toBe('View office-mini');
    expect(view.getAttribute('href')).toBe('/machines/office-mini');
    await click($('[data-act=wz-again]'));
    expect(title()).toBe('Name your new machine');
    expect($<HTMLInputElement>('#wz-alias')!.value).toBe('');
    expect($('.modal .eyebrow')!.textContent).toBe('Add machine · step 1 of 3');
    type($<HTMLInputElement>('#wz-alias'), 'second');
    await submit($('form[data-form=wz]'));
    await waitFor(() => $('.wz-link'));
    await advance(100);
    await waitFor(() => $$('.link-row').some(r => r.textContent!.includes('office-mini')));
  });

  it('View machine navigates to the machine and closes the wizard', async () => {
    await open();
    await toStep3('office-mini');
    await advance(12_000);
    await waitFor(() => /is online/.test(title()));
    await app!.router.push('/machines/office-mini');
    await app!.settle();
    expect($('.modal')).toBeNull();
    expect(app!.ctx.wizard.open).toBe(false);
  });
});

describe('deadlines and polling limits', () => {
  it('asks for its own link by ID, never scans the list, shows the expired state at expiry and stops (wizardExpiry)', async () => {
    await open({ enroll: false, expiry: 8, pagesize: 1 });
    await toStep3('office-mini');
    await advance(6000);
    const id = app!.mock.links[0]!.id;
    expect(app!.mock.calls.filter(c => c.path === `enrollment-links/${id}`).length).toBeGreaterThanOrEqual(1);
    const firstById = app!.mock.calls.find(c => c.path === `enrollment-links/${id}`)!;
    expect(app!.mock.calls.some(c => c.path === 'enrollment-links' && c.method === 'GET' && c.at > firstById.at - 1)).toBe(false);
    await advance(6000);
    await waitFor(() => /expired before/.test($('.wz-wait')?.textContent ?? ''));
    expect($('.wz-wait')!.textContent).toContain('The link expired before office-mini used it.');
    expect($('.wz-wait')!.textContent).toContain('Create a new link for the same alias.');
    expect($('[data-act=wz-new]')).not.toBeNull();
    expect($('.wz-checks li.cur')).toBeNull();
    const n = linkReads(app!);
    await advance(12_000);
    expect(linkReads(app!)).toBe(n);
  });

  it('Create a new link starts again with the same alias', async () => {
    await open({ enroll: false, expiry: 8 });
    await toStep3('office-mini');
    await advance(15_000);
    await waitFor(() => $('[data-act=wz-new]'));
    await click($('[data-act=wz-new]'));
    expect(title()).toBe('Name your new machine');
    expect($<HTMLInputElement>('#wz-alias')!.value).toBe('office-mini');
    expect($('.modal .eyebrow')!.textContent).toBe('Add machine · step 1 of 3');
  });

  it('a revoked link is reported as expired', async () => {
    await open({ enroll: false });
    await toStep3('office-mini');
    app!.mock.links.find(l => l.alias === 'office-mini')!.state = 'revoked';
    app!.mock.links.find(l => l.alias === 'office-mini')!.revokedAt = new Date().toISOString();
    await advance(6000);
    await waitFor(() => /expired before/.test($('.wz-wait')?.textContent ?? ''));
  });

  it('polling stops when the dialog closes (wizardClose)', async () => {
    await open({ enroll: false, pagesize: 1 });
    await toStep3('office-mini');
    await waitFor(() => idReads() >= 1, { timeout: 6000 });
    await closeWizard();
    await advance(100);
    const n = idReads();
    await advance(12_000);
    expect(idReads()).toBe(n);
  });

  it('polling stops when the route changes, and the dialog goes with it (wizardRoute)', async () => {
    await open({ enroll: false, pagesize: 1 });
    await toStep3('office-mini');
    await waitFor(() => idReads() >= 1, { timeout: 6000 });
    await app!.go('/audit');
    await waitFor(() => !$('.modal') && $('h1')?.textContent === 'Audit');
    expect(app!.ctx.wizard.open).toBe(false);
    const n = idReads();
    await advance(12_000);
    expect(idReads()).toBe(n);
    expect(app!.mock.calls.filter(c => !c.settled)).toHaveLength(0);
  });

  it('gives up on a machine that enrolled but never checks in, offers Check again, and stops polling (wizardStalled)', async () => {
    await open({ enroll: 'link' } as never);
    app!.mock.options.enrollLinkOnly = true;
    await closeIfOpen();
    await toStep3('office-mini');
    await advance(11 * 60 * 1000 + 30_000);
    await waitFor(() => $('[data-act=wz-recheck]'));
    expect($('.wz-wait')!.textContent).toContain('office-mini enrolled, but it has not checked in yet.');
    expect($('.wz-wait')!.textContent).toContain('Fleet stopped listening. Check that the Agent service is running on the machine, then check again.');
    expect($('.wz-checks li:nth-child(2)')!.classList.contains('done')).toBe(true);
    expect($('.wz-checks li:nth-child(3) .spinner')).toBeNull();
    expect($('.wz-wait .muted.small')).toBeNull();
    const polls = (): number => app!.mock.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path) || c.path.startsWith('nodes/')).length;
    const n = polls();
    await advance(30_000);
    expect(polls()).toBe(n);
    await click($('[data-act=wz-recheck]'));
    expect($('[data-act=wz-recheck]')).toBeNull();
    await advance(400);
    expect(polls()).toBeGreaterThan(n);
    await advance(11 * 60 * 1000 + 30_000);
    await waitFor(() => $('[data-act=wz-recheck]'));
  });

  it('still shows the expired state at the expiry although every link read fails (wizardFailReads)', async () => {
    await open({ enroll: false, expiry: 8, fail: 'enrollment-links/' });
    await toStep3('office-mini');
    await advance(16_000);
    await waitFor(() => /expired before/.test($('.wz-wait')?.textContent ?? ''));
    expect($('[data-act=wz-new]')).not.toBeNull();
    expect(idReads()).toBeGreaterThan(0);
    const n = idReads();
    await advance(10_000);
    expect(idReads()).toBe(n);
  });

  it('a link read that never answers is cancelled by its timeout and does not keep the expired state away (wizardHang)', async () => {
    await open({ enroll: false, expiry: 8, hang: 'enrollment-links/' });
    await toStep3('office-mini');
    await advance(25_000);
    await waitFor(() => /expired before/.test($('.wz-wait')?.textContent ?? ''));
    const reads = app!.mock.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(c => c.aborted)).toBe(true);
  });

  it('stops waiting after the limit although every Node read fails (wizardStalledFail)', async () => {
    await open({ fail: 'nodes/' });
    app!.mock.options.enrollLinkOnly = true;
    await toStep3('office-mini');
    await advance(12 * 60 * 1000);
    await waitFor(() => $('[data-act=wz-recheck]'));
    expect($('.wz-wait')!.textContent).toContain('has not checked in yet');
    const polls = (): number => app!.mock.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path) || c.path.startsWith('nodes/')).length;
    const n = polls();
    await advance(20_000);
    expect(polls()).toBe(n);
  });

  it('keeps asking while the Node does not exist yet (node_not_found is not a reason to stop)', async () => {
    await open();
    await toStep3('office-mini');
    await advance(6500);
    await waitFor(() => $('.wz-checks li:nth-child(2)')?.classList.contains('done'));
    const early = app!.mock.calls.filter(c => c.path.startsWith('nodes/office-mini'));
    expect(early.length).toBeGreaterThan(0);
    expect($('.wz-3')).not.toBeNull();
    expect($('[data-act=wz-recheck]')).toBeNull();
  });
});

const closeIfOpen = async (): Promise<void> => { if ($('.modal')) await closeWizard(); };

describe('answers that arrive after the wizard was closed (wizardStaleCreate, wizardStaleCreateError)', () => {
  async function stale(failing: boolean): Promise<void> {
    await open({ enroll: false, lag: { 'enrollment-links': 3000 }, forbid: failing });
    await click(addButton());
    await waitFor(() => $('#wz-alias'));
    type($<HTMLInputElement>('#wz-alias'), 'old-alias');
    await submit($('form[data-form=wz]'));
    await advance(300);
    await click($('.modal [data-act=modal-close]'));
    expect($('.modal')).toBeNull();
    await click(addButton());
    await waitFor(() => $('#wz-alias'));
    type($<HTMLInputElement>('#wz-alias'), 'new-alias');
    await advance(3600);
    expect($('#wz-alias')).not.toBeNull();
    expect($('.wz-link')).toBeNull(); // the late answer does not turn the new wizard into step 2
    expect($<HTMLInputElement>('#wz-alias')!.value).toBe('new-alias');
    expect($('#wz-alias-msg')!.classList.contains('is-err') || /scope does not allow/.test($('.modal')!.textContent!)).toBe(false);
    expect($('.toast')?.textContent ?? '').not.toContain('Enrollment link created');
    expect(modalText()).not.toContain('old-alias');
    await submit($('form[data-form=wz]'));
    if (failing) {
      await advance(3600);
      await waitFor(() => $('#wz-alias-msg')?.classList.contains('is-err'));
      expect($('#wz-alias-msg')!.textContent).toMatch(/scope/);
    } else {
      await advance(3600);
      await waitFor(() => $('.wz-link'));
      expect($('.wz-link-top')!.textContent).toContain('new-alias');
      expect($('.modal')!.textContent).not.toContain('old-alias');
    }
  }
  it('the late link of the closed wizard does not reach the new one', () => stale(false));
  it('the late error of the closed wizard is not shown in the new one', () => stale(true));

  it('a link created for a wizard nobody looks at shows up in the list behind it', async () => {
    await open({ enroll: false, lag: { 'enrollment-links': 3000 } });
    await click(addButton());
    await waitFor(() => $('#wz-alias'));
    type($<HTMLInputElement>('#wz-alias'), 'ghost');
    await submit($('form[data-form=wz]'));
    await advance(300);
    await click($('.modal [data-act=modal-close]'));
    await advance(3600);
    await waitFor(() => $$('.link-row').some(r => r.textContent!.includes('ghost')));
  });
});

describe('dialog behaviour', () => {
  it('Escape closes it and focus returns to the Add machine button', async () => {
    await open();
    const add = addButton();
    add.focus();
    await click(add);
    expect($('.modal')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect($('.modal')).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it('closing with the backdrop or Cancel closes it; nothing is requested for a wizard that created nothing', async () => {
    await open();
    await click(addButton());
    await click($('.modal-back'));
    expect($('.modal')).toBeNull();
    await click(addButton());
    await click($('.wz-foot [data-act=modal-close]'));
    expect($('.modal')).toBeNull();
    expect(app!.mock.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
  });

  it('moves focus to the first useful control at each step', async () => {
    await open({ enroll: false });
    await toStep2('office-mini');
    expect(document.activeElement).toBe($('.cmd--link .copy'));
    await click($('[data-act=wz-wait]'));
    expect(document.activeElement).toBe($('[data-act=wz-back]'));
  });

  it('with a read token the wizard does not open: a toast explains', async () => {
    await open({ scope: 'read' });
    app!.ctx.wizard.show();
    await flushPromises();
    await flushPromises();
    expect($('.modal')).toBeNull();
    expect(app!.ctx.wizard.open).toBe(false);
    expect($('.toast')!.textContent).toMatch(/Needs the admin scope/);
  });

  it('works from the Machines page: closing after a link was created reloads the gallery behind it', async () => {
    await open({ enroll: false }, '/machines');
    const before = app!.mock.calls.filter(c => c.method === 'GET' && c.path === 'nodes').length;
    await toStep2('office-mini');
    await closeWizard();
    await advance(500);
    await waitFor(() => app!.mock.calls.filter(c => c.method === 'GET' && c.path === 'nodes').length > before);
    expect($$('.card').length).toBeGreaterThan(5);
  });

  it('the link is kept only in the open dialog (never in the router state or the list)', async () => {
    await open({ enroll: false });
    await toStep2('office-mini');
    const link = $('.cmd--link code')!.textContent!;
    expect(JSON.stringify(app!.router.currentRoute.value)).not.toContain('fleet-v1');
    expect($('#view')!.textContent).not.toContain('fleet-v1');
    await closeWizard();
    expect(document.body.textContent).not.toContain(link);
    expect(textOf($('#view'))).not.toContain('fleet-v1');
  });
});
