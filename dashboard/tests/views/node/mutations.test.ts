/**
 * Rename, revoke and remove, and what happens when their answers arrive after the user has moved on. Ports of the Dev/drive.js
 * scenarios rename, revoke, revokeConfirm, remove, removeConfirm, renameStale, renameTab, removeStale, removeKeep, revokeStale
 * (lag=<kind>:3000 on the mock), plus validation, refusals, focus and keyboard behaviour of the dialogs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TIMERS, currentTab, openNode, type NodeTest } from './helpers';
import { waitFor } from '../../helpers/app';
import NodeView from '@/views/Node/NodeView.vue';
import { NODE_PAGE, type NodePage } from '@/views/Node/nodePage';

let t: NodeTest | undefined;
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

const input = () => t!.find('#rename-alias').element as HTMLInputElement;
const setAlias = async (v: string) => { await t!.find('#rename-alias').setValue(v); };
const submit = async () => { await t!.find('form[data-form=rename]').trigger('submit'); await t!.app.settle(); };
const modal = () => t!.find('.modal');
const route = () => t!.app.router.currentRoute.value;
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await t!.app.settle(); };
const nodeExists = (alias: string) => t!.app.mock.nodes.some(n => n.alias === alias);

describe('rename (rename)', () => {
  it('saves the new alias, follows it to the same tab of the new address, and keeps the "Renamed from" note', async () => {
    t = await openNode('/machines/studio-mini/settings');
    expect(currentTab(t)).toBe('Settings');
    expect(t.text('#rename-msg')).toBe('After renaming, update the key under nodes: in fleet.yml too.');
    expect(input().maxLength).toBe(201);
    expect(input().autocomplete).toBe('off');
    await setAlias('studio-renamed');
    await submit();
    await t.until(() => /studio-renamed/.test(route().fullPath), 'route follows new alias');
    expect(route().fullPath).toBe('/machines/studio-renamed/settings');
    await t.ready('studio-renamed');
    expect(t.text('#rename-msg'), 'rename success message').toBe('Renamed from studio-mini. Update its entry in fleet.yml too.');
    expect(t.find('#rename-msg').classes()).toContain('is-ok');
    expect(t.find('#rename-msg').attributes('role')).toBe('status');
    expect(t.toasts()).toContain('Alias changed');
    expect(t.toasts()).toContain('Update its entry in fleet.yml too.');
    expect(t.posts(/^nodes\/rename$/)[0]!.body).toEqual({ currentAlias: 'studio-mini', alias: 'studio-renamed' });
    expect(document.title).toBe('studio-renamed · Fleet Manager');
    expect(t.find('nav.tabs').attributes('aria-label')).toBe('studio-renamed sections');
    expect((input()).value).toBe('studio-renamed');
  });

  it('the note belongs to the page the rename opened: it is gone after leaving and coming back', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await setAlias('studio-renamed');
    await submit();
    await t.ready('studio-renamed');
    await t.go('/machines/design-imac/settings');
    await t.go('/machines/studio-renamed/settings');
    expect(t.text('#rename-msg')).toBe('After renaming, update the key under nodes: in fleet.yml too.');
  });

  it('trims the alias before sending it', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await setAlias('  trimmed-name  ');
    await submit();
    await t.until(() => /trimmed-name/.test(route().fullPath));
    expect(t.posts(/^nodes\/rename$/)[0]!.body).toEqual({ currentAlias: 'studio-mini', alias: 'trimmed-name' });
  });

  it('the same alias is not sent: "That is already the alias."', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await setAlias(' studio-mini ');
    await submit();
    expect(t.text('#rename-msg')).toBe('That is already the alias.');
    expect(t.find('#rename-msg').classes(), 'neither an error nor a success').not.toContain('is-err');
    expect(t.find('#rename-msg').classes()).not.toContain('is-ok');
    expect(t.posts()).toHaveLength(0);
  });

  it.each([['blank', '   '], ['too long', 'x'.repeat(201)]])('a %s alias is refused before any request, with aria-invalid', async (_n, value) => {
    t = await openNode('/machines/studio-mini/settings');
    await setAlias(value);
    await submit();
    expect(t.text('#rename-msg')).toBe('Choose a nonblank alias of at most 200 characters.');
    expect(t.find('#rename-msg').classes()).toContain('is-err');
    expect(t.find('#rename-alias').attributes('aria-invalid')).toBe('true');
    expect(t.posts()).toHaveLength(0);
    await setAlias('ok-name');
    await submit();
    await t.until(() => /ok-name/.test(route().fullPath));
  });

  it('an alias that is taken (409) is shown in the form and as a toast, and the button works again', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await setAlias('design-imac');
    await submit();
    await t.until(() => t!.find('#rename-msg').classes().includes('is-err'), 'error message');
    expect(t.text('#rename-msg')).toBe('That alias is already in use.');
    expect(t.find('#rename-alias').attributes('aria-invalid')).toBe('true');
    expect(t.toasts()).toContain('Rename failed');
    expect(route().fullPath).toBe('/machines/studio-mini/settings');
    expect(t.find('form[data-form=rename] button[type=submit]').attributes('disabled')).toBeUndefined();
    expect(nodeExists('studio-mini')).toBe(true);
  });

  it('the button is disabled while the request runs, so it cannot be sent twice', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { rename: 1000 } });
    await setAlias('studio-renamed');
    await submit();
    expect(t.find('form[data-form=rename] button[type=submit]').attributes('disabled')).toBeDefined();
    await submit();
    expect(t.posts(/^nodes\/rename$/)).toHaveLength(1);
    await advance(1500);
    expect(route().fullPath).toBe('/machines/studio-renamed/settings');
  });

  it('with the operate scope the form is locked and explained; clicking Save explains and sends nothing', async () => {
    t = await openNode('/machines/studio-mini/settings', { scope: 'operate' });
    expect(input().disabled).toBe(true);
    const save = t.find('form[data-form=rename] .is-locked[data-need=admin]');
    expect(save.text()).toBe('Save alias');
    expect(save.attributes('aria-disabled')).toBe('true');
    expect(save.attributes('data-tip')).toMatch(/Needs the admin scope/);
    expect(t.text('#rename-msg')).toMatch(/^Needs the admin scope\./);
    await save.trigger('click');
    expect(t.toasts()).toContain('Not available');
    await t.find('form[data-form=rename]').trigger('submit');
    expect(t.posts()).toHaveLength(0);
    expect(t.text('.panel--danger .lock-note')).toMatch(/Needs the admin scope/);
  });
});

describe('an alias that looks like markup', () => {
  it('is text on every part of the page, in the title, the dialogs and the links', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    const hostile = '<img src=x onerror=alert(1)>';
    t = await openNode('/machines/studio-mini/settings');
    await setAlias(hostile);
    await submit();
    await t.until(() => /settings$/.test(route().fullPath) && route().params.alias === hostile, 'renamed');
    await t.ready(hostile);
    expect(t.find('.nhero h1').text()).toBe(hostile);
    expect(document.title).toBe(`${hostile} · Fleet Manager`);
    expect(t.tabs().every(a => a.attributes('href')!.startsWith('/machines/%3Cimg'))).toBe(true);
    await t.click('.panel--danger [data-act=remove-node]');
    expect(t.text('#modal-root h2')).toBe(`Remove ${hostile} permanently?`);
    expect(t.findAll('#root img, #root script, #root [onerror]')).toHaveLength(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await t.go(`/machines/${encodeURIComponent(hostile)}/problems`);
    await t.go(`/machines/${encodeURIComponent(hostile)}/activity`);
    await t.until(() => t!.exists('.tl-item'));
    expect(t.findAll('#root img, #root script, #root [onerror]')).toHaveLength(0);
    expect(alerts).toBe(0);
  });
});

describe('revoke (revoke, revokeConfirm)', () => {
  it('opens a dialog that names the machine, takes the focus, explains what happens and shows the stop command', async () => {
    t = await openNode('/machines/studio-mini');
    const opener = t.find('.nhero-actions [data-act=revoke-node]');
    (opener.element as HTMLElement).focus();
    await opener.trigger('click');
    await t.until(() => t!.exists('.modal'), 'revoke modal');
    expect(t.text('#modal-root h2')).toBe('Revoke access for studio-mini?');
    expect(t.text('#modal-root .modal-head p')).toBe('Its certificates stop working immediately and the Agent can no longer poll.');
    expect(modal().attributes('role')).toBe('dialog');
    expect(modal().attributes('aria-modal')).toBe('true');
    expect(modal().attributes('aria-labelledby')).toBe(t.find('#modal-root h2').attributes('id'));
    expect(modal().element.contains(document.activeElement), 'focus moves into dialog').toBe(true);
    expect(document.activeElement?.textContent, 'on Cancel').toBe('Cancel');
    const ticks = t.findAll('.modal .ticks li').map(li => li.text());
    expect(ticks).toEqual([
      'The machine record, its history and its alias stay. The alias remains reserved.',
      'Nothing is deleted on the machine.',
      'studio-mini moves to Retired. To use the alias again you would remove it and enroll it again.',
    ]);
    expect(t.text('.modal .kv-label')).toBe('Then stop the Agent on studio-mini');
    expect(t.find('.modal .cmd code').text()).toBe('brew services stop jcarcaboso/fleet/fleet-agent');
    expect(t.find('.modal .cmd button.copy').attributes('data-copy')).toBe('brew services stop jcarcaboso/fleet/fleet-agent');
    expect(t.text('.modal .muted.small')).toBe('Installed it as a user service instead? Run fleet-agent service stop.');
    expect(t.posts()).toHaveLength(0);
    // Escape closes it and the focus returns to the button that opened it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await t.app.settle();
    expect(t.exists('.modal')).toBe(false);
    expect(document.activeElement).toBe(opener.element);
  });

  it('Cancel and the close button close it without a request', async () => {
    t = await openNode('/machines/studio-mini/security');
    await t.click('.panel--danger [data-act=revoke-node]');
    expect(t.exists('.modal')).toBe(true);
    await t.find('.modal .icon-btn[aria-label=Close]').trigger('click');
    expect(t.exists('.modal')).toBe(false);
    await t.click('.panel--danger [data-act=revoke-node]');
    await t.findAll('.modal-foot button').find(b => b.text() === 'Cancel')!.trigger('click');
    expect(t.exists('.modal')).toBe(false);
    expect(t.posts()).toHaveLength(0);
  });

  it('confirming revokes the machine: toast, Retired header, no Revoke button, and the page reads the machine again', async () => {
    t = await openNode('/machines/studio-mini');
    await t.click('.nhero-actions [data-act=revoke-node]');
    const confirm = t.findAll('.modal-foot button').find(b => b.text() === 'Revoke access')!;
    expect(confirm.classes()).toContain('btn-danger');
    await confirm.trigger('click');
    await t.until(() => /revoked/i.test(t!.toasts()), 'revoked toast');
    expect(t.toasts()).toContain('studio-mini revoked');
    expect(t.toasts()).toContain('Node access revoked. Stop its Agent on the machine.');
    await t.until(() => t!.exists('.nhero--retired'), 'retired hero');
    expect(t.exists('.modal'), 'the dialog closed').toBe(false);
    expect(t.exists('.nhero-actions [data-act=revoke-node]')).toBe(false);
    expect(t.posts(/\/revoke$/)[0]!.path).toBe(`nodes/${t.app.mock.nodes.find(n => n.alias === 'studio-mini')!.id}/revoke`);
    expect(t.posts(/\/revoke$/)[0]!.body).toEqual({});
    expect(t.app.mock.audit[0]).toMatchObject({ action: 'node_revoked', actor: 'joan' });
  });

  it('a refusal (403) is shown in the dialog and as a toast, and the dialog stays usable', async () => {
    t = await openNode('/machines/studio-mini', { forbid: true });
    await t.click('.nhero-actions [data-act=revoke-node]');
    await t.findAll('.modal-foot button').find(b => b.text() === 'Revoke access')!.trigger('click');
    await t.until(() => t!.exists('.modal .field-msg.is-err'), 'error in the dialog');
    expect(t.text('.modal .field-msg')).toMatch(/scope|cannot do that/);
    expect(t.find('.modal .field-msg').attributes('role')).toBe('alert');
    expect(t.toasts()).toMatch(/scope|cannot do that/);
    const confirm = t.findAll('.modal-foot button').find(b => b.text() === 'Revoke access')!;
    expect(confirm.attributes('disabled')).toBeUndefined();
    expect(t.exists('.nhero--retired')).toBe(false);
  });

  it('the Revoke button is locked for an operate token, with its reason, and opens nothing', async () => {
    t = await openNode('/machines/studio-mini', { scope: 'operate' });
    const btn = t.find('.nhero-actions .is-locked[data-need=admin]');
    expect(btn.exists()).toBe(true);
    await t.findAll('.nhero-actions .is-locked').find(b => b.text() === 'Revoke')!.trigger('click');
    expect(t.exists('.modal')).toBe(false);
    expect(t.toasts()).toContain('Not available');
    expect(t.toasts()).toContain('Needs the admin scope');
  });
});

describe('remove (remove, removeConfirm)', () => {
  const openRemove = async () => { await t!.click('.nhero-actions [data-act=remove-node]'); await t!.until(() => t!.exists('.modal input'), 'remove modal'); };
  const go = () => t!.findAll('.modal-foot button').find(b => b.text() === 'Remove machine')!;
  const typeAlias = async (v: string) => { await t!.find('.modal input').setValue(v); };

  it('Remove stays disabled until the alias is typed exactly, with a hint as you type', async () => {
    t = await openNode('/machines/studio-mini');
    await openRemove();
    expect(t.text('#modal-root h2')).toBe('Remove studio-mini permanently?');
    expect(t.text('#modal-root .modal-head p')).toBe('This deletes its server record, credentials, assignments and attempts. It cannot be undone.');
    expect(document.activeElement, 'the input has the focus').toBe(t.find('.modal input').element);
    expect(t.find('.modal label').text()).toBe('Type studio-mini to confirm');
    expect(go().attributes('disabled'), 'disabled until alias typed').toBeDefined();
    expect(t.text('.modal .field-msg')).toBe('The alias must match exactly, including case.');
    await typeAlias('studio-mi');
    expect(go().attributes('disabled'), 'partial alias keeps remove disabled').toBeDefined();
    expect(t.text('.modal .field-msg')).toBe('Keep typing…');
    await typeAlias('studio-x');
    expect(t.text('.modal .field-msg')).toBe('That does not match the alias.');
    expect(t.find('.modal .field-msg').classes()).toContain('is-err');
    await typeAlias('Studio-Mini');
    expect(go().attributes('disabled'), 'case matters').toBeDefined();
    await typeAlias('studio-mini');
    expect(go().attributes('disabled'), 'exact alias enables remove').toBeUndefined();
    expect(t.text('.modal .field-msg')).toBe('Alias matches. This will permanently remove the machine.');
    expect(t.find('.modal .field-msg').classes()).toContain('is-ok');
    expect(t.findAll('.modal .ticks li').map(li => li.text())).toEqual([
      'Audit history and shared release data remain.',
      'The alias studio-mini becomes available for a new enrollment.',
      'Files on the machine are not erased. Stop its Agent and remove its fleet.yml entry unless you will enroll a replacement.',
    ]);
    expect(t.posts()).toHaveLength(0);
  });

  it('confirming removes the machine, toasts, and returns to the list', async () => {
    t = await openNode('/machines/studio-mini');
    await openRemove();
    await typeAlias('studio-mini');
    await go().trigger('click');
    await t.until(() => route().name === 'machines', 'back to the list');
    expect(route().fullPath).toBe('/machines');
    expect(t.posts(/\/remove$/)[0]!.body).toEqual({ alias: 'studio-mini' });
    expect(t.toasts()).toContain('studio-mini removed');
    expect(t.toasts()).toContain('Its alias is available for a new enrollment.');
    expect(nodeExists('studio-mini')).toBe(false);
    expect(t.exists('.modal')).toBe(false);
    expect(t.exists('.nhero')).toBe(false);
  });

  it('Enter in the field confirms once the alias matches', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await t.click('.panel--danger [data-act=remove-node]');
    await typeAlias('studio-mini');
    await t.find('.modal input').trigger('keydown', { key: 'Enter' });
    await t.until(() => route().name === 'machines');
    expect(nodeExists('studio-mini')).toBe(false);
  });

  it('Enter does nothing while the alias does not match', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await t.click('.panel--danger [data-act=remove-node]');
    await typeAlias('studio');
    await t.find('.modal input').trigger('keydown', { key: 'Enter' });
    await t.app.settle();
    expect(t.posts()).toHaveLength(0);
    expect(t.exists('.modal')).toBe(true);
  });

  it('a refusal (409: the alias changed meanwhile) is shown in the dialog and the dialog stays', async () => {
    t = await openNode('/machines/studio-mini');
    await openRemove();
    await typeAlias('studio-mini');
    await t.app.ctx.api.post('nodes/rename', { currentAlias: 'studio-mini', alias: 'studio-other' });
    await go().trigger('click');
    await t.until(() => t!.find('.modal .field-msg').classes().includes('is-err'), 'error in the dialog');
    expect(t.text('.modal .field-msg')).toBe('This machine was renamed. Refresh the page before removing it.');
    expect(t.toasts()).toContain('That did not work');
    expect(go().attributes('disabled')).toBeUndefined();
    expect(route().name).toBe('node');
  });

  it('the Remove button is locked for an operate token', async () => {
    t = await openNode('/machines/studio-mini/settings', { scope: 'operate' });
    const locked = t.findAll('.is-locked[data-need=admin]');
    expect(locked.map(b => b.text()).sort()).toEqual(['Remove', 'Remove…', 'Revoke', 'Save alias'].sort());
    await t.find('.panel--danger .is-locked').trigger('click');
    expect(t.exists('.modal')).toBe(false);
    expect(t.posts()).toHaveLength(0);
  });
});

describe('answers that arrive after the user moved on (lag=<kind>:3000)', () => {
  it('renameStale: no redirect, a toast, the machine is found under its new alias afterwards', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { rename: 3000 } });
    await setAlias('studio-renamed');
    await submit();
    await advance(300);
    await t.app.router.push('/machines/design-imac');
    await t.ready('design-imac');
    await advance(3600);
    expect(route().fullPath, 'a rename that answers later does not pull the user back to the machine').toBe('/machines/design-imac');
    expect(t.find('.nhero h1').text()).toBe('design-imac');
    expect(t.toasts(), 'a toast says the machine was renamed').toContain('studio-mini is now studio-renamed');
    expect(t.toasts()).toContain('Update its entry in fleet.yml too.');
    expect(t.toasts()).not.toContain('Alias changed');
    await t.go('/machines/studio-renamed');
    await t.ready('studio-renamed');
    expect(t.find('.nhero h1').text(), 'the machine is found under its new alias afterwards').toBe('studio-renamed');
    await t.go('/machines/studio-mini');
    await t.until(() => t!.exists('.empty h1'));
    expect(t.text('.empty h1')).toBe('We could not find “studio-mini”');
  });

  it('renameStale (to another page of the app): no redirect either', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { rename: 3000 } });
    await setAlias('studio-renamed');
    await submit();
    await advance(300);
    await t.app.router.push('/enrollment');
    await t.app.settle();
    await advance(3600);
    expect(route().fullPath).toBe('/enrollment');
    expect(t.toasts()).toContain('studio-mini is now studio-renamed');
  });

  it('renameTab: switching tabs on the same machine does not stop the rename from following', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { rename: 3000 } });
    await setAlias('studio-renamed');
    await submit();
    await advance(300);
    await t.app.router.push('/machines/studio-mini/overview');
    await t.app.settle();
    expect(currentTab(t)).toBe('Overview');
    await advance(3600);
    await t.until(() => /^\/machines\/studio-renamed\//.test(route().fullPath), 'rename follows the user to the new alias');
    expect(route().fullPath, 'switching tabs on the same machine does not stop the rename from following').toBe('/machines/studio-renamed/settings');
    await t.ready('studio-renamed');
    expect(t.toasts()).toContain('Alias changed');
    expect(t.text('#rename-msg')).toBe('Renamed from studio-mini. Update its entry in fleet.yml too.');
  });

  it('removeStale: no redirect to the list, a toast, the machine is gone', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { remove: 3000 } });
    await t.click('.panel--danger [data-act=remove-node]');
    await t.find('.modal input').setValue('studio-mini');
    await t.findAll('.modal-foot button').find(b => b.text() === 'Remove machine')!.trigger('click');
    await advance(300);
    await t.app.router.push('/machines/design-imac');
    await t.ready('design-imac');
    await advance(3600);
    expect(route().fullPath, 'a removal that answers later does not send the user to the machine list').toBe('/machines/design-imac');
    expect(t.toasts(), 'a toast says the machine was removed').toContain('studio-mini removed');
    expect(nodeExists('studio-mini'), 'the machine is gone on the Server').toBe(false);
    expect(t.find('.nhero h1').text()).toBe('design-imac');
    expect(t.exists('.modal')).toBe(false);
    await t.go('/machines/studio-mini');
    await t.until(() => t!.exists('.empty h1'));
    expect(t.text('.empty h1')).toBe('We could not find “studio-mini”');
  });

  it('removeKeep: a removal started on this machine still returns to the list after a tab change', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { remove: 3000 } });
    await t.click('.panel--danger [data-act=remove-node]');
    await t.find('.modal input').setValue('studio-mini');
    await t.findAll('.modal-foot button').find(b => b.text() === 'Remove machine')!.trigger('click');
    await advance(300);
    await t.app.router.push('/machines/studio-mini/activity');
    await t.app.settle();
    expect(currentTab(t)).toBe('Activity');
    await advance(3600);
    await t.until(() => route().name === 'machines', 'removal from the page it was started on goes to the list');
    expect(route().fullPath).toBe('/machines');
  });

  it('revokeStale: the late answer does not close a dialog that belongs to something else', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { revoke: 3000 } });
    await t.click('.nhero-actions [data-act=revoke-node]');
    await t.findAll('.modal-foot button').find(b => b.text() === 'Revoke access')!.trigger('click');
    await advance(300);
    await t.app.router.push('/machines/design-imac');
    await t.ready('design-imac');
    await t.click('.nhero-actions [data-act=remove-node]');
    expect(t.text('#modal-root h2')).toBe('Remove design-imac permanently?');
    await advance(3600);
    expect(t.exists('.modal input'), 'a revoke that answers later does not close the dialog the user opened since').toBe(true);
    expect(t.text('#modal-root h2')).toBe('Remove design-imac permanently?');
    expect(t.toasts(), 'a toast says the machine was revoked').toContain('studio-mini revoked');
    expect(t.exists('.nhero--retired'), 'and design-imac is not touched').toBe(false);
    expect(t.gets(/^nodes\/studio-mini$/), 'the page that was left is not read again').toHaveLength(1);
  });

  it('a retry that answers after the user left still toasts and does not reload the page they are on', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/problems', { lag: { retry: 3000 } });
    await t.click('[data-act=retry]');
    await advance(300);
    await t.app.router.push('/machines/design-imac');
    await t.ready('design-imac');
    const reads = t.gets(/^nodes\//).length;
    await advance(3600);
    expect(t.toasts()).toContain('Retry requested for Claude Code connection on studio-mini');
    expect(t.gets(/^nodes\//).length, 'no reload of the page the user went to').toBe(reads);
    expect(t.find('.nhero h1').text()).toBe('design-imac');
  });

  it('a late disk answer after leaving never repaints the page the user is on', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/build-runner-02', { diskDelay: 1000 });
    await waitFor(() => t!.exists('[data-act=disk-refresh]'));
    await t.click('[data-act=disk-refresh]');
    await advance(2000);
    await t.app.router.push('/machines/studio-mini');
    await t.ready('studio-mini');
    const calls = t.app.mock.calls.length;
    await advance(60_000);
    expect(t.app.mock.calls.length).toBe(calls);
    expect(t.text('#disk-status')).toBe('');
  });
});

describe('the dialogs close on any route change (Back, Forward, a tab link)', () => {
  const openRevoke = async () => { await t!.click('.nhero-actions [data-act=revoke-node], .nhero-actions .btn-danger'); await t!.until(() => t!.exists('.modal'), 'revoke modal'); };
  const openRemove = async () => { await t!.click('.panel--danger [data-act=remove-node]'); await t!.until(() => t!.exists('.modal input'), 'remove modal'); };
  const page = () => (t!.w().findComponent(NodeView).vm as any).$.provides[NODE_PAGE as symbol] as NodePage;

  it('a tab change closes the Revoke dialog', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await openRevoke();
    await t.app.router.push('/machines/studio-mini/activity');
    await t.app.settle();
    expect(t.exists('.modal')).toBe(false);
    expect(page().dialog.value).toBeNull();
    expect(document.getElementById('modal-root')!.hasAttribute('hidden')).toBe(true);
    expect(t.posts()).toHaveLength(0);
  });

  it('browser Back and Forward close the Remove dialog', async () => {
    t = await openNode('/machines/studio-mini/overview');
    await t.go('/machines/studio-mini/settings');
    await openRemove();
    t.app.router.back();
    await t.app.settle();
    expect(currentTab(t)).toBe('Overview');
    expect(t.exists('.modal'), 'Back').toBe(false);
    t.app.router.forward();
    await t.app.settle();
    expect(currentTab(t)).toBe('Settings');
    expect(t.exists('.modal'), 'Forward does not bring it back').toBe(false);
    expect(page().dialog.value).toBeNull();
  });

  it('another machine has its own page and no dialog', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await openRemove();
    await t.go('/machines/design-imac/settings');
    expect(t.exists('.modal')).toBe(false);
    expect(page().dialog.value).toBeNull();
  });

  it('a dialog that is busy closes too, and its late answer neither reopens it nor closes the next dialog', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { revoke: 3000 } });
    await openRevoke();
    await t.findAll('.modal-foot button').find(b => b.text() === 'Revoke access')!.trigger('click');
    await advance(300);
    await t.app.router.push('/machines/studio-mini/overview');
    await t.app.settle();
    expect(t.exists('.modal'), 'closed although the request is still running').toBe(false);
    await t.app.router.push('/machines/studio-mini/settings');
    await t.app.settle();
    await openRemove(); // someone else's dialog
    await advance(3600);
    expect(t.exists('.modal input'), 'the late revoke answer leaves the Remove dialog alone').toBe(true);
    expect(t.text('#modal-root h2')).toBe('Remove studio-mini permanently?');
    expect(t.toasts()).toContain('studio-mini revoked');
  });

  it('a removal that was confirmed before a tab change still returns to the list', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/settings', { lag: { remove: 3000 } });
    await openRemove();
    await t.find('.modal input').setValue('studio-mini');
    await t.findAll('.modal-foot button').find(b => b.text() === 'Remove machine')!.trigger('click');
    await advance(300);
    await t.app.router.push('/machines/studio-mini/overview');
    await advance(3600);
    expect(route().fullPath).toBe('/machines');
    expect(t.exists('.modal')).toBe(false);
  });
});

describe('what a rename leaves behind', () => {
  it('a rename whose navigation does not happen leaves no "Renamed from" note for a later page', async () => {
    t = await openNode('/machines/studio-mini/settings');
    t.app.router.beforeEach(to => (to.params.alias === 'studio-renamed' ? false : true));
    await setAlias('studio-renamed');
    await submit();
    await t.app.settle();
    expect(t.posts(/^nodes\/rename$/)).toHaveLength(1);
    expect(route().fullPath, 'the navigation was refused').toBe('/machines/studio-mini/settings');
    expect(t.app.ctx.renameNotes.size, 'nothing waits for a page that never opens').toBe(0);
  });

  it('a rename that is followed leaves no note behind once the new page took it', async () => {
    t = await openNode('/machines/studio-mini/settings');
    await setAlias('studio-renamed');
    await submit();
    await t.ready('studio-renamed');
    expect(t.text('#rename-msg')).toContain('Renamed from studio-mini');
    expect(t.app.ctx.renameNotes.size).toBe(0);
  });

  it('signing out forgets a note that was never taken', async () => {
    t = await openNode('/machines/studio-mini/settings');
    t.app.ctx.renameNotes.set('somebody', 'Renamed from anybody. Update its entry in fleet.yml too.');
    await t.app.ctx.session.logout();
    await t.app.settle();
    expect(t.app.ctx.renameNotes.size).toBe(0);
  });

  it('a rename, a removal and the gallery search: the old galleryReset', async () => {
    t = await openNode('/machines/studio-mini/settings');
    t.app.ctx.gallery.search = 'mac';
    await setAlias('studio-renamed');
    await submit();
    await t.ready('studio-renamed');
    expect(t.app.ctx.gallery.search).toBe('');
    t.app.ctx.gallery.search = 'mac';
    await t.click('.panel--danger [data-act=remove-node]');
    await t.until(() => t!.exists('.modal input'));
    await t.find('.modal input').setValue('studio-renamed');
    await t.findAll('.modal-foot button').find(b => b.text() === 'Remove machine')!.trigger('click');
    await t.app.settle();
    expect(t.app.ctx.gallery.search).toBe('');
  });
});
