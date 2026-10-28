/**
 * Your account (password change, the forced first change of the default `fleet` account) and the Accounts page (admin: list, add,
 * change scope, set a password, delete).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.restoreAllMocks(); });

const w = () => app!.wrapper;
const toasts = () => textOf(w().find('#toasts').element);
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const posts = (path: string) => app!.mock.calls.filter(c => c.method === 'POST' && c.path === path);

async function changePassword(current: string, next: string, repeat = next): Promise<void> {
  field('password-current').value = current;
  field('password-new').value = next;
  field('password-repeat').value = repeat;
  await w().find('form.account-form').trigger('submit');
  await app!.settle();
}

describe('Your account', () => {
  it('is open from the user menu and shows the account, the password form and the theme', async () => {
    app = await mountApp();
    expect(w().find('#me .me-link').attributes('href')).toBe('/account');
    await app.go('/account');
    expect(w().find('h1').text()).toBe('Your account');
    expect(w().find('.account-who h2').text()).toBe('joan');
    expect(w().find('#password-required').exists()).toBe(false);
    expect(w().findAll('form.account-form input[type="password"]').map(i => i.attributes('autocomplete'))).toEqual(['current-password', 'new-password', 'new-password']);
    expect(w().find('.account-panel .theme-switch').exists()).toBe(true);
  });

  it('checks the new password in the page first, without a request', async () => {
    app = await mountApp({ path: '/account' });
    await changePassword('', 'a-new-passphrase');
    expect(w().find('#password-msg').text()).toBe('Enter your current password.');
    await changePassword('old-password', 'short');
    expect(w().find('#password-msg').text()).toBe('Choose a new password of 10 to 256 characters.');
    await changePassword('a-new-passphrase', 'a-new-passphrase');
    expect(w().find('#password-msg').text()).toBe('The new password must differ from the current one.');
    await changePassword('old-password', 'a-new-passphrase', 'another-passphrase');
    expect(w().find('#password-msg').text()).toBe('The two new passwords do not match.');
    expect(document.activeElement).toBe(field('password-repeat'));
    expect(posts('account/password')).toHaveLength(0);
  });

  it('changes the password, clears the fields and stays on the page', async () => {
    app = await mountApp({ path: '/account' });
    await changePassword('old-password', 'a-new-passphrase');
    expect(posts('account/password').map(c => c.body)).toEqual([{ currentPassword: 'old-password', newPassword: 'a-new-passphrase' }]);
    expect(w().find('#password-msg').text()).toBe('Password changed.');
    expect(['password-current', 'password-new', 'password-repeat'].map(id => field(id).value)).toEqual(['', '', '']);
    expect(toasts()).toContain('Password changed');
    expect(app.router.currentRoute.value.name).toBe('account');
    expect(w().html()).not.toContain('a-new-passphrase');
  });

  it('shows a wrong current password from the Server', async () => {
    app = await mountApp({ path: '/account' });
    await changePassword('bad-password', 'a-new-passphrase');
    expect(w().find('#password-msg').text()).toBe('Your current password is not correct.');
    expect(w().find('#password-msg').classes()).toContain('is-err');
  });

  it('a session that must change its password is held on the page with no navigation, then continues where it was going', async () => {
    app = await mountApp({ path: '/problems', mock: { mustChangePassword: true } });
    expect(app.router.currentRoute.value.name).toBe('account');
    expect(app.router.currentRoute.value.query.redirect).toBe('/problems');
    expect(w().find('#password-required').text()).toContain('Choose a new password');
    expect(w().find('#nav').exists()).toBe(false);
    expect(w().find('#me #sign-out').exists()).toBe(true);
    await app.go('/audit');
    expect(app.router.currentRoute.value.name).toBe('account');
    expect(app.router.currentRoute.value.query.redirect).toBe('/audit');
    /* The navigation badges wait too: their routes would only answer 403 password_change_required. */
    const badgeReads = () => app!.mock.calls.filter(c => c.method === 'GET' && (c.path === 'issues' || c.path === 'cliproxy/status'));
    expect(badgeReads()).toHaveLength(0);
    expect(app.mock.calls.some(c => c.status === 403)).toBe(false);
    await changePassword('old-password', 'a-new-passphrase');
    await waitFor(() => app!.router.currentRoute.value.name === 'audit');
    expect(w().find('#nav').exists()).toBe(true);
    await waitFor(() => badgeReads().length === 2);
  });

  it('a 403 password_change_required on an open page sends the visitor to the password page', async () => {
    app = await mountApp({ path: '/audit' });
    app.mock.state.mustChangePassword = true;
    await w().find('[data-act="reload"]').trigger('click');
    await app.settle();
    await waitFor(() => app!.router.currentRoute.value.name === 'account');
    expect(app.router.currentRoute.value.query.redirect).toBe('/audit');
  });
});

const rows = () => w().findAll('#accounts-body tr');
const row = (name: string) => w().find(`#accounts-body tr[data-account="${name}"]`);

describe('Accounts page', () => {
  it('lists the accounts by name with scope and password state, and marks the signed-in one', async () => {
    app = await mountApp({ path: '/accounts' });
    expect(w().find('h1').text()).toBe('Accounts');
    expect(rows().map(r => r.attributes('data-account'))).toEqual(['ana', 'fleet', 'joan', 'viewer']);
    expect(row('joan').find('.who').text()).toContain('You');
    expect((row('ana').find('select').element as HTMLSelectElement).value).toBe('operate');
    expect(row('fleet').text()).toContain('Must change at sign-in');
    expect(row('ana').text()).toContain('Set by the user');
  });

  it('is in the navigation for admins only, and other scopes see a lock note', async () => {
    app = await mountApp({ path: '/accounts', mock: { scope: 'operate' } });
    expect(w().findAll('#nav a').map(a => a.attributes('href'))).not.toContain('/accounts');
    expect(w().find('.lock-note').text()).toBe('Needs the admin scope. Your account has operate access.');
    expect(app.mock.calls.some(c => c.path === 'accounts')).toBe(false);
  });

  it('adds an account that must choose its own password', async () => {
    app = await mountApp({ path: '/accounts' });
    await w().find('[data-act="add-account"]').trigger('click');
    await app.settle();
    const name = field('account-name');
    name.value = 'New.User';
    name.dispatchEvent(new Event('input'));
    const scope = document.getElementById('account-scope') as HTMLSelectElement;
    scope.value = 'operate';
    scope.dispatchEvent(new Event('change'));
    field('account-password').value = 'short';
    (document.getElementById('add-account-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await app.settle();
    expect(document.getElementById('account-msg')?.textContent).toBe('Choose a first password of 10 to 256 characters.');
    expect(posts('accounts')).toHaveLength(0);
    field('account-password').value = 'first-password-123';
    (document.getElementById('add-account-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await app.settle();
    expect(posts('accounts').map(c => c.body)).toEqual([{ name: 'new.user', password: 'first-password-123', scope: 'operate' }]);
    expect(document.querySelector('.modal')).toBeNull();
    await waitFor(() => row('new.user').exists());
    expect(row('new.user').text()).toContain('Must change at sign-in');
    expect(toasts()).toContain('Account added');
  });

  it('refuses a name that is taken before asking the Server', async () => {
    app = await mountApp({ path: '/accounts' });
    await w().find('[data-act="add-account"]').trigger('click');
    await app.settle();
    const name = field('account-name');
    name.value = 'ana';
    name.dispatchEvent(new Event('input'));
    field('account-password').value = 'first-password-123';
    (document.getElementById('add-account-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await app.settle();
    expect(document.getElementById('account-msg')?.textContent).toBe('An account with that name already exists.');
    expect(posts('accounts')).toHaveLength(0);
  });

  it('changes a scope, and keeps the last admin an admin', async () => {
    app = await mountApp({ path: '/accounts' });
    const select = row('ana').find('select');
    (select.element as HTMLSelectElement).value = 'read';
    await select.trigger('change');
    await app.settle();
    expect(posts('accounts/ana/scope').map(c => c.body)).toEqual([{ scope: 'read' }]);
    await waitFor(() => (row('ana').find('select').element as HTMLSelectElement).value === 'read');
    const fleet = row('fleet').find('select');
    (fleet.element as HTMLSelectElement).value = 'read';
    await fleet.trigger('change');
    await app.settle();
    await waitFor(() => (row('fleet').find('select').element as HTMLSelectElement).value === 'read');
    /* joan is now the only admin: the scope cannot be lowered and the account cannot be deleted. */
    expect(row('joan').find('select').attributes('disabled')).toBeDefined();
    expect(row('joan').find('[data-act="delete-joan"]').attributes('aria-disabled')).toBe('true');
    expect(toasts()).toContain('Scope changed');
  });

  it('sets a temporary password', async () => {
    app = await mountApp({ path: '/accounts' });
    await row('ana').find('[data-act="password-ana"]').trigger('click');
    await app.settle();
    expect(document.querySelector('.modal h2')?.textContent).toBe('Set a password for ana');
    field('reset-password').value = 'temporary-pass-1';
    (document.getElementById('reset-password-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await app.settle();
    expect(posts('accounts/ana/password').map(c => c.body)).toEqual([{ password: 'temporary-pass-1' }]);
    await waitFor(() => row('ana').text().includes('Must change at sign-in'));
  });

  it('deletes an account after confirmation, but never the signed-in one', async () => {
    app = await mountApp({ path: '/accounts' });
    await row('joan').find('[data-act="delete-joan"]').trigger('click');
    await app.settle();
    expect(document.querySelector('.modal')).toBeNull();
    expect(toasts()).toContain('You cannot delete the account you are signed in with.');
    await row('viewer').find('[data-act="delete-viewer"]').trigger('click');
    await app.settle();
    expect(document.querySelector('.modal h2')?.textContent).toBe('Delete viewer?');
    (document.querySelector('.modal .btn-danger') as HTMLButtonElement).click();
    await app.settle();
    expect(posts('accounts/viewer/delete')).toHaveLength(1);
    await waitFor(() => !row('viewer').exists());
    expect(toasts()).toContain('Account deleted');
  });
});
