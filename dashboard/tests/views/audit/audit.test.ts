/**
 * Audit page. Port of the Dev/drive.js scenario audit (order=newest, one screenful, load older events), plus rows, labels, search and
 * filters, empty, loading, error and abort states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@/api/types';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const w = () => app!.wrapper;
const rows = () => w().findAll('#audit-body tr');
const cells = (tr: ReturnType<typeof rows>[number]) => tr.findAll('td').map(td => td.text().replace(/\s+/g, ' ').trim());
const calls = () => app!.mock.calls.filter(c => c.path === 'audit');
const toasts = () => textOf(w().find('#toasts').element);
const count = () => w().find('#audit-count').text();

describe('Audit page: rows', () => {
  it('lists every event newest first with when, who, what and machine', async () => {
    app = await mountApp({ path: '/audit' });
    expect(w().find('h1').text()).toBe('Audit');
    expect(w().findAll('table.tbl--audit th').map(t => t.text())).toEqual(['When (UTC)', 'Who', 'What', 'Subject']);
    expect(rows()).toHaveLength(14);
    expect(count()).toBe('14 events');
    const first = rows()[0]!;
    expect(first.find('.when b').text(), 'an event from today shows the time only').toMatch(/^\d\d:\d\d$/);
    expect(first.find('.when .muted').text()).toMatch(/ago$/);
    expect(first.find('.who b').text()).toBe('joan');
    expect(first.find('.who .muted').text()).toBe('Operator');
    expect(first.find('.who .av').text()).toBe('J');
    expect(first.find('.what').text()).toBe('Created an enrollment linkenrollment_authorization_created');
    expect(first.find('.what code').text()).toBe('enrollment_authorization_created');
    expect(first.find('.what-ic svg').exists()).toBe(true);
    expect(cells(first)[3]).toBe('—');
    const enrolled = rows().find(r => r.text().includes('Machine enrolled'))!;
    expect(enrolled.find('.who .muted').text()).toBe('Enrollment');
    expect(enrolled.find('a.subj').text()).toBe('lab-vm-07');
    expect(enrolled.find('a.subj').attributes('href')).toMatch(/^\/machines\/[0-9a-f-]{36}$/);
    const times = w().findAll('#audit-body .when b').map(b => b.text());
    expect(times.find(t => !/^\d\d:\d\d$/.test(t)), 'older events show the day').toMatch(/^[A-Z][a-z]{2} \d+, \d\d:\d\d$/);
  });

  it('an Agent is named Agent, with its short ID in the filter; a removed machine and a credential are named', async () => {
    app = await mountApp({ path: '/audit' });
    const renewed = rows().find(r => r.text().includes('homelab-nuc'))!;
    expect(renewed.find('.who b').text()).toBe('Agent');
    expect(renewed.find('.who .muted').text()).toBe('Agent');
    expect(renewed.find('.what b, .what').text()).toContain('Certificate renewed');
    const removed = rows().find(r => r.text().includes('Removed a machine'))!;
    expect(removed.find('.subj').text()).toBe('Removed machine');
    const id = removed.findAll('td')[3]!.find('code.small');
    expect(id.text()).toMatch(/^[0-9a-f]{8}$/);
    expect(id.attributes('data-tip')).toMatch(/^[0-9a-f-]{36}$/);
    expect(w().findAll('#audit-actor option').map(o => o.text())).toEqual(['Everyone', 'Agent 28fa9b82', 'Agent 4965d79a', 'ana', 'enrollment', 'joan']);
    expect(w().findAll('#audit-action option').map(o => o.text())).toEqual([
      'All actions', 'Saved a model selection', 'Created an enrollment link', 'Revoked an enrollment link', 'Renamed a machine', 'Certificate renewed', 'Machine enrolled',
      'Removed a machine', 'Revoked a machine', 'Requested a repository sync',
    ]);
  });

  it('events with a credential but no machine show the credential', async () => {
    app = await mountApp({ path: '/machines' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: AuditEvent[]; nextCursor: string | null }>)(path, ...rest);
      return path === 'audit' ? { ...r, items: [{ recordedAt: new Date().toISOString(), action: 'node_credential_revoked', actor: 'joan', nodeId: null, credentialId: '0123456789abcdef-aaaa', nodeName: null }, ...r.items] } : r;
    };
    await app.go('/audit');
    expect(cells(rows()[0]!)[3]).toBe('credential 01234567');
    expect(rows()[0]!.find('.what').text()).toContain('Revoked a credential');
  });

  it('an action this dashboard has no label for is written out; an event with an invalid time is dropped', async () => {
    app = await mountApp({ path: '/machines' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: AuditEvent[]; nextCursor: string | null }>)(path, ...rest);
      if (path !== 'audit') return r;
      const t = new Date().toISOString();
      return { ...r, items: [
        { recordedAt: t, action: 'node.something_new', actor: 'joan', nodeId: null, credentialId: null, nodeName: null },
        { recordedAt: 'not a date', action: 'node_revoked', actor: 'bad', nodeId: null, credentialId: null, nodeName: null },
        ...r.items,
      ] };
    };
    await app.go('/audit');
    expect(rows()).toHaveLength(15);
    expect(rows()[0]!.find('.what').text()).toBe('Node something newnode.something_new');
    expect(w().text()).not.toContain('Invalid Date');
    expect(w().findAll('#audit-actor option').map(o => o.text())).not.toContain('bad');
  });
});

describe('Audit page: search and filters', () => {
  it('search matches the action, its label, the actor and the machine', async () => {
    app = await mountApp({ path: '/audit' });
    await w().find('#audit-q').setValue('homelab');
    expect(rows()).toHaveLength(1);
    expect(count()).toBe('1 event');
    await w().find('#audit-q').setValue('  ENROLLMENT_authorization ');
    expect(rows()).toHaveLength(4);
    await w().find('#audit-q').setValue('renamed');
    expect(rows().map(r => r.find('.subj').text())).toEqual(['studio-mini']);
    await w().find('#audit-q').setValue('agent');
    expect(rows()).toHaveLength(2);
    await w().find('#audit-q').setValue('zzzz');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.find('.empty-mini p').text()).toBe('No audit events match these filters.');
    expect(rows()[0]!.find('td').attributes('colspan')).toBe('4');
    expect(count()).toBe('0 events');
    await w().find('#audit-q').setValue('');
    expect(rows()).toHaveLength(14);
  });

  it('the actor and action filters combine with the search', async () => {
    app = await mountApp({ path: '/audit' });
    await w().find('#audit-actor').setValue('joan');
    expect(rows().every(r => r.find('.who b').text() === 'joan')).toBe(true);
    expect(rows()).toHaveLength(7);
    await w().find('#audit-action').setValue('source_rescan_requested');
    expect(rows()).toHaveLength(2);
    expect(count()).toBe('2 events');
    await w().find('#audit-q').setValue('nothing like this');
    expect(rows()[0]!.text()).toContain('No audit events match these filters.');
    await w().find('#audit-q').setValue('');
    await w().find('#audit-actor').setValue('all');
    await w().find('#audit-action').setValue('all');
    expect(rows()).toHaveLength(14);
    const agent = w().findAll('#audit-actor option')[1]!.element.getAttribute('value')!;
    await w().find('#audit-actor').setValue(agent);
    expect(rows()).toHaveLength(1);
  });

  it('the controls are labelled', async () => {
    app = await mountApp({ path: '/audit' });
    expect(w().find('label.search .sr').text()).toBe('Search audit log');
    expect(w().find('#audit-q').attributes('type')).toBe('search');
    expect(w().find('#audit-q').attributes('placeholder')).toBe('Search actions, actors and machines');
    expect(w().findAll('label.sel > span').map(s => s.text())).toEqual(['Actor', 'Action']);
  });
});

describe('Audit page: paging (audit, pagesize=3)', () => {
  it('requests order=newest with one screenful, and Load older events follows the cursor', async () => {
    app = await mountApp({ path: '/audit', mock: { pageSize: 3 } });
    expect(calls().every(c => c.query.order === 'newest'), 'audit is requested with order=newest').toBe(true);
    expect(rows(), 'first page only (3 events)').toHaveLength(3);
    expect(calls()[0]!.query.limit, 'asks for one screenful').toBe('50');
    expect(w().find('#audit-more-note').text()).toBe('Search and filters apply to the 3 newest events loaded so far.');
    await w().find('[data-act=more-audit]').trigger('click');
    expect(w().find('[data-act=more-audit]').attributes('disabled')).toBeDefined();
    await waitFor(() => rows().length === 6, { label: 'second page' });
    expect(calls().at(-1)!.query.after).toBeTruthy();
    expect(calls().at(-1)!.query.order).toBe('newest');
    expect(w().find('#audit-more-note').text()).toBe('Search and filters apply to the 6 newest events loaded so far.');
    while (w().find('[data-act=more-audit]').exists()) {
      const n = rows().length;
      await w().find('[data-act=more-audit]').trigger('click');
      await waitFor(() => rows().length > n);
    }
    expect(rows()).toHaveLength(14);
    expect(w().find('#audit-more-note').exists()).toBe(false);
  });

  it('filters apply to everything loaded so far, including older pages', async () => {
    app = await mountApp({ path: '/audit', mock: { pageSize: 3 } });
    await w().find('#audit-q').setValue('removed');
    expect(rows()[0]!.text()).toContain('No audit events match these filters.');
    for (let i = 0; i < 4; i++) {
      if (!w().find('[data-act=more-audit]').exists()) break;
      const n = calls().length;
      await w().find('[data-act=more-audit]').trigger('click');
      await waitFor(() => calls().length > n);
      await app.settle();
    }
    expect(rows().map(r => r.find('.subj').text())).toEqual(['Removed machine']);
  });

  it('a failing "Load older events" is explained and can be tried again', async () => {
    app = await mountApp({ path: '/audit', mock: { pageSize: 3 } });
    app.mock.options.fail = 'audit';
    await w().find('[data-act=more-audit]').trigger('click');
    await waitFor(() => toasts().includes('Could not load older events'));
    expect(rows()).toHaveLength(3);
    expect(w().find('[data-act=more-audit]').attributes('disabled')).toBeUndefined();
    app.mock.options.fail = null;
    await w().find('[data-act=more-audit]').trigger('click');
    await waitFor(() => rows().length === 6);
  });

  it('Refresh loads the first page again and drops what older pages added', async () => {
    app = await mountApp({ path: '/audit', mock: { pageSize: 3 } });
    await w().find('[data-act=more-audit]').trigger('click');
    await waitFor(() => rows().length === 6);
    await w().find('[data-act=reload]').trigger('click');
    await waitFor(() => rows().length === 3, { label: 'first page again' });
  });

  it('a page that is refreshed while older events load drops the old answer', async () => {
    app = await mountApp({ path: '/audit', mock: { pageSize: 3 } });
    app.mock.options.slow = 150;
    await w().find('[data-act=more-audit]').trigger('click');
    await w().find('[data-act=reload]').trigger('click');
    await waitFor(() => rows().length > 0, { timeout: 4000 });
    await new Promise(r => setTimeout(r, 400));
    expect(rows()).toHaveLength(3);
    expect(calls().filter(c => c.query.after).every(c => c.aborted)).toBe(true);
  });
});

describe('Audit page: empty, loading, error and abort', () => {
  it('no events yet', async () => {
    app = await mountApp({ path: '/audit', mock: { empty: true } });
    expect(w().find('.empty h2').text()).toBe('No audit events yet');
    expect(w().find('.empty p').text()).toBe('Operator actions, enrollment and certificate renewals are recorded here.');
    expect(w().find('table').exists()).toBe(false);
    expect(w().find('#audit-q').exists()).toBe(false);
  });

  it('shows the loading skeleton, then the page', async () => {
    app = await mountApp({ path: '/machines' });
    app.mock.options.slow = 150;
    void app.router.push('/audit');
    await waitFor(() => w().find('[role=status] .skel').exists());
    await waitFor(() => w().find('table').exists(), { timeout: 4000 });
  });

  it('a failing read shows the error, and Try again recovers', async () => {
    app = await mountApp({ path: '/audit', mock: { fail: 'audit' } });
    expect(w().find('h1').text()).toBe('Could not load Audit');
    app.mock.options.fail = null;
    await w().find('.empty--error button').trigger('click');
    await waitFor(() => w().find('table').exists());
  });

  it('a token that cannot read shows "Your account cannot open this"', async () => {
    app = await mountApp({ path: '/machines' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = (path: string, ...rest: unknown[]) =>
      (path === 'audit' ? Promise.reject(Object.assign(new Error('Your Operator scope does not allow this action.'), { status: 403, silent: false })) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await app.go('/audit');
    expect(w().find('h1').text()).toBe('Your account cannot open this');
    expect(w().find('.empty--error button').exists()).toBe(false);
  });

  it('leaving the page aborts the read in flight', async () => {
    app = await mountApp({ path: '/machines', mock: { hang: 'audit' } });
    await app.go('/audit');
    const hung = calls();
    expect(hung).toHaveLength(1);
    expect(hung[0]!.settled).toBe(false);
    await app.go('/machines');
    expect(hung[0]!.aborted).toBe(true);
  });

  it('is readable with a read token, and has no stray undefined text (scan)', async () => {
    app = await mountApp({ path: '/audit', mock: { scope: 'read' } });
    expect(w().find('.is-locked').exists()).toBe(false);
    expect(textOf(w().find('#view').element)).not.toMatch(/undefined|\bnull\b|NaN|Invalid Date|\[object/);
    expect(document.title).toBe('Audit · Fleet Manager');
  });
});

describe('Audit page: hostile text', () => {
  it('names and actors render as text', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    app = await mountApp({ path: '/machines' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: AuditEvent[]; nextCursor: string | null }>)(path, ...rest);
      return path === 'audit' ? { ...r, items: [{ recordedAt: new Date().toISOString(), action: '<img src=x onerror=alert(1)>', actor: '"><svg onload=alert(2)>', nodeId: 'id"><script>', credentialId: null, nodeName: '<img src=x onerror=alert(3)>' }, ...r.items] } : r;
    };
    await app.go('/audit');
    expect(rows()[0]!.text()).toContain('<img src=x onerror=alert(1)>');
    expect(rows()[0]!.text()).toContain('"><svg onload=alert(2)>');
    expect(rows()[0]!.find('a.subj').text()).toBe('<img src=x onerror=alert(3)>');
    expect(document.querySelectorAll('#view img, #view script, #view svg[onload], #view [onerror]').length).toBe(0);
    expect(alerts).toBe(0);
  });
});
