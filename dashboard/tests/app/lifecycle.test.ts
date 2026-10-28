/** What the shell does when the page is hidden, when the route changes, and when the session ends. */
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideTip, tooltip } from '@/composables/tooltip';
import { mountApp, settle, waitFor, type TestApp } from '../helpers/app';
import { $, $$, click, submit, toStep2, type } from '../views/enrollment/helpers';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); hideTip(); });
const pagehide = (): void => { window.dispatchEvent(new Event('pagehide')); };

describe('pagehide (the page may come back from the back/forward cache exactly as it was)', () => {
  it('closes the Add machine wizard, so the one-time enrollment link cannot show again', async () => {
    app = await mountApp({ path: '/machines' });
    await toStep2('office-mini');
    const link = $('.wz-link')!.textContent ?? '';
    expect(link).toContain('fleet-v1=');
    pagehide();
    await settle();
    expect(app.ctx.wizard.open).toBe(false);
    expect($('.modal')).toBeNull();
    expect(document.body.textContent).not.toContain('fleet-v1=');
    expect(document.body.innerHTML).not.toContain(link.slice(-40));
    /* A restored page opens a fresh wizard, empty. */
    app.ctx.wizard.show();
    await settle();
    expect($<HTMLInputElement>('#wz-alias')!.value).toBe('');
    expect($('.wz-link')).toBeNull();
  });

  it('a link that is still being created when the page is hidden never reaches a screen', async () => {
    app = await mountApp({ path: '/machines', mock: { lag: { 'enrollment-links': 300 } } });
    await click($$('.btn-primary').find(b => /Add machine/.test(b.textContent ?? ''))!);
    await waitFor(() => $('#wz-alias'));
    type($<HTMLInputElement>('#wz-alias'), 'office-mini');
    await submit($('form[data-form=wz]'));
    pagehide();
    await settle();
    await new Promise(r => setTimeout(r, 450));
    await settle();
    expect($('.modal')).toBeNull();
    expect(document.body.textContent).not.toContain('fleet-v1=');
    expect(app.ctx.wizard.open).toBe(false);
  });

  it('clears the password field on the sign-in page', async () => {
    app = await mountApp({ path: '/machines', mock: { signedOut: true } });
    await waitFor(() => document.getElementById('login-password'));
    const input = document.getElementById('login-password') as HTMLInputElement;
    input.value = 'secret-token-0123456789-abcdefghijklmnop';
    pagehide();
    expect(input.value).toBe('');
  });

  it('is harmless when nothing is open', async () => {
    app = await mountApp({ path: '/problems' });
    pagehide();
    await settle();
    expect(app.wrapper.find('#view h1').text()).toBe('Problems');
  });
});

describe('the tooltip does not outlive the page it belongs to', () => {
  it('a tooltip shown on the Revision page is gone after following a link to a machine', async () => {
    app = await mountApp({ path: '/machines' });
    await app.go('/deployments/' + app.mock.data.revisions[0]!.id);
    const link = await waitFor(() => document.querySelector<HTMLAnchorElement>('#view a.tchip--error[data-tip]'));
    link.dispatchEvent(new Event('pointerover', { bubbles: true }));
    await flushPromises();
    expect(tooltip.visible).toBe(true);
    expect(document.querySelector('#tip')?.textContent).toBeTruthy();
    await app.wrapper.find('#view a.tchip--error[data-tip]').trigger('click');
    await waitFor(() => app!.router.currentRoute.value.name === 'node');
    await app.settle();
    expect(tooltip.visible).toBe(false);
    expect(document.querySelector('#tip')?.classList.contains('show') ?? false).toBe(false);
  });

  it('a navigation that does not happen leaves it alone', async () => {
    app = await mountApp({ path: '/machines' });
    await app.go('/deployments/' + app.mock.data.revisions[0]!.id);
    const link = await waitFor(() => document.querySelector<HTMLAnchorElement>('#view a.tchip--error[data-tip]'));
    link.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(tooltip.visible).toBe(true);
    app.router.beforeEach(() => false);
    await app.wrapper.find('#view a.tchip--error[data-tip]').trigger('click');
    await app.settle();
    expect(tooltip.visible).toBe(true);
  });
});

describe('signing out ends everything that belonged to the Operator', () => {
  it('the enrollment bus: user A\'s form error, request and revoked link are not user B\'s', async () => {
    app = await mountApp({ path: '/enrollment', mock: { forbid: true } });
    await waitFor(() => $('#en-alias'));
    type($<HTMLInputElement>('#en-alias'), 'office-mini');
    await submit($('form.form'));
    await waitFor(() => $('#wz-alias-msg')?.classList.contains('is-err'));
    await click($('.modal [data-act=modal-close]'));
    expect($('#en-msg')!.textContent).toMatch(/scope/i);
    const bus = app.ctx.enrollmentBus;
    expect(bus).toMatchObject({ formErr: true });
    expect(bus.formMsg).toMatch(/scope/i);
    bus.request = { alias: 'left-over', expiry: 900 };
    bus.revoked('11111111-1111-4111-8111-111111111111');
    const version = bus.version;

    await app.ctx.session.logout();
    await waitFor(() => app!.router.currentRoute.value.name === 'login');
    await settle();
    expect(bus).toMatchObject({ formMsg: '', formErr: false, request: null, revokedId: null });
    expect(bus.version, 'a reset does not wake the list pages').toBe(version);

    app.mock.options.forbid = false;
    await app.signIn();
    await app.go('/enrollment');
    await waitFor(() => $('#en-msg'));
    expect($('#en-msg')!.textContent).toBe('The guided setup shows the install and enroll commands next.');
    expect($('#en-msg')!.classList.contains('is-err')).toBe(false);
    expect($('.modal'), 'no wizard from the other session').toBeNull();
  });

  it('the Add machine wizard closes and the gallery search is cleared', async () => {
    app = await mountApp({ path: '/machines' });
    app.ctx.gallery.search = 'linux';
    app.ctx.wizard.show();
    await settle();
    expect($('.modal')).not.toBeNull();
    await app.ctx.session.logout();
    await settle();
    expect(app.ctx.wizard.open).toBe(false);
    expect($('.modal')).toBeNull();
    expect(app.ctx.gallery.search).toBe('');
  });
});
