import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import type { Issue } from '@/api/types';
import ChangeChips from '@/components/ChangeChips.vue';
import CheckinChart from '@/components/CheckinChart.vue';
import CheckinStrip from '@/components/CheckinStrip.vue';
import ChipsFilter from '@/components/ChipsFilter.vue';
import CopyBox from '@/components/CopyBox.vue';
import CopyButton from '@/components/CopyButton.vue';
import Countdown from '@/components/Countdown.vue';
import CountdownBar from '@/components/CountdownBar.vue';
import DeviceArt from '@/components/DeviceArt.vue';
import DiagLine from '@/components/DiagLine.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import FailureDetail from '@/components/FailureDetail.vue';
import FileList from '@/components/FileList.vue';
import GapList from '@/components/GapList.vue';
import Icon from '@/components/Icon.vue';
import InlineError from '@/components/InlineError.vue';
import IssueActions from '@/components/IssueActions.vue';
import IssueBanner from '@/components/IssueBanner.vue';
import Legend from '@/components/Legend.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import LockNote from '@/components/LockNote.vue';
import MdText from '@/components/MdText.vue';
import RevChip from '@/components/RevChip.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import ScopeGate from '@/components/ScopeGate.vue';
import Segbar from '@/components/Segbar.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StatusPill from '@/components/StatusPill.vue';
import StateTag from '@/components/StateTag.vue';
import StepsList from '@/components/StepsList.vue';
import TabNav from '@/components/TabNav.vue';
import Timeline from '@/components/Timeline.vue';
import { hideTip, tooltip } from '@/composables/tooltip';
import { stateParts } from '@/lib/targets';
import { ICON_PATHS } from '@/lib/icons';
import { componentHarness, settle } from '../helpers/app';

const XSS = '<img src=x onerror=alert(1)>"><script>alert(2)</script>';
const noInjected = (root: Element): void => {
  expect(root.querySelector('img, script, [onerror], [onclick], [onload]')).toBeNull();
};
afterEach(() => { hideTip(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Icon, glyph, pill, tag', () => {
  it('renders the exact paths of the old icon set, hidden from assistive technology', () => {
    const w = mount(Icon, { props: { name: 'sync' }, attrs: { class: 'spin' } });
    const svg = w.element;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('class')).toBe('ic spin');
    expect(svg.querySelectorAll('path')).toHaveLength(4);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M20 11a8 8 0 0 0-14.6-4.4L4 8.5');
    const circle = mount(Icon, { props: { name: 'search' } }).element;
    expect(circle.querySelector('circle')?.getAttribute('r')).toBe('7');
    expect(ICON_PATHS.search).toContain('r="7"');
  });
  it('a glyph is a coloured shape with a mark; a warning is a triangle, pending a ring', () => {
    const good = mount(StatusGlyph, { props: { level: 'good' } }).element;
    expect(good.getAttribute('class')).toBe('g');
    expect(good.querySelector('circle')?.getAttribute('fill')).toBe('#0ca30c');
    expect(good.querySelector('g path')?.getAttribute('d')).toBe('M4.7 8.3l2.2 2.2 4.5-4.6');
    const warn = mount(StatusGlyph, { props: { level: 'warning', kind: 'bang' } }).element;
    expect(warn.querySelector('circle')).toBeNull();
    expect(warn.querySelector('path')?.getAttribute('fill')).toBe('#fab219');
    expect(warn.querySelector('g')?.getAttribute('stroke')).toBe('#3d2c00');
    const pending = mount(StatusGlyph, { props: { level: 'pending' } }).element;
    expect(pending.querySelector('circle')?.getAttribute('stroke')).toBe('#a9a397');
    const moon = mount(StatusGlyph, { props: { level: 'serious' } }).element;
    expect(moon.querySelector('g path')?.getAttribute('fill')).toBe('#fff');
    const ban = mount(StatusGlyph, { props: { level: 'neutral', kind: 'ban' } }).element;
    expect(ban.querySelectorAll('g circle')).toHaveLength(1);
  });
  it('a pill and a tag always carry an icon and a word', () => {
    const pill = mount(StatusPill, { props: { level: 'critical', kind: 'bang', label: 'Action needed' } });
    expect(pill.classes()).toEqual(expect.arrayContaining(['pill', 't-critical']));
    expect(pill.find('svg.g').exists()).toBe(true);
    expect(pill.find('span').text()).toBe('Action needed');
    for (const [state, label] of [['succeeded', 'In sync'], ['applying', 'Applying'], ['pending', 'Waiting'], ['failed', 'Failed'], ['superseded', 'Superseded'], ['mystery', 'Mystery']]) {
      const tag = mount(StateTag, { props: { state: state! } });
      expect(tag.find('svg.g').exists(), state).toBe(true);
      expect(tag.text()).toBe(label);
    }
    expect(mount(StatusPill, { props: { level: 'good', label: XSS } }).element.querySelector('img')).toBeNull();
  });
});

describe('text blocks', () => {
  it('MdText turns backticks into <code> and never into markup', () => {
    const w = mount(defineComponent(() => () => h('p', [h(MdText, { text: `Run \`fleet explain x\` or ${XSS} \`<b>\`` })])));
    expect(Array.from((w.element as Element).querySelectorAll('code'), c => c.textContent)).toEqual(['fleet explain x', '<b>']);
    expect(w.text()).toBe(`Run fleet explain x or ${XSS} <b>`);
    noInjected(w.element);
  });
  it('EmptyState: icon or check, heading level, text and actions', () => {
    const w = mount(EmptyState, { props: { icon: 'rocket', title: 'Nothing yet', text: 'Sync it.' }, slots: { default: () => h('button', 'Go') } });
    expect(w.find('h2').text()).toBe('Nothing yet');
    expect(w.find('h2').attributes('tabindex')).toBe('-1');
    expect(w.find('.empty-art svg.ic').exists()).toBe(true);
    expect(w.find('p').text()).toBe('Sync it.');
    expect(w.find('button').exists()).toBe(true);
    const good = mount(EmptyState, { props: { good: true, title: 'No problems', h: 'h1' } });
    expect(good.classes()).toContain('empty--good');
    expect(good.find('h1').exists()).toBe(true);
    expect(good.find('.empty-art.good svg.g').exists()).toBe(true);
    expect(good.find('p').exists()).toBe(false);
  });
  it('ErrorState: retry, forbidden and plain failure', async () => {
    const w = mount(ErrorState, { props: { error: { message: 'The Server had a problem (500).', status: 500 }, what: 'Machines' } });
    expect(w.attributes('role')).toBe('alert');
    expect(w.find('h1').text()).toBe('Could not load Machines');
    expect(w.find('p').text()).toBe('The Server had a problem (500).');
    await w.find('button').trigger('click');
    expect(w.emitted('retry')).toHaveLength(1);
    const forbidden = mount(ErrorState, { props: { error: { message: 'Needs the admin scope.', status: 403 } } });
    expect(forbidden.find('h1').text()).toBe('Your account cannot open this');
    expect(forbidden.find('button').exists()).toBe(false);
    expect(mount(ErrorState, { props: { error: null, retry: false } }).find('p').text()).toBe('Something went wrong.');
    expect(mount(ErrorState, { props: { error: { message: XSS } } }).element.querySelector('img')).toBeNull();
  });
  it('InlineError and LoadingBlock', () => {
    const inline = mount(InlineError, { props: { what: 'older activity', error: { message: 'No.' } } });
    expect(inline.attributes('role')).toBe('alert');
    expect(inline.text()).toContain('Could not load older activity');
    const page = mount(LoadingBlock);
    expect(page.attributes('role')).toBe('status');
    expect(page.find('.sr').text()).toBe('Loading…');
    expect(mount(LoadingBlock, { props: { kind: 'cards' } }).findAll('.skel-card')).toHaveLength(6);
  });
  it('RevChip shows the short SHA and the full one as tooltip text', () => {
    const w = mount(RevChip, { props: { sha: 'a3f9c21d0c5b4e8f', tip: 'a3f9c21d0c5b4e8f' } });
    expect(w.text()).toBe('a3f9c21');
    expect(w.attributes('data-tip')).toBe('a3f9c21d0c5b4e8f');
    expect(mount(RevChip, { props: { sha: null } }).text()).toBe('Nothing yet');
  });
  it('StepsList numbers steps and does not count alternatives', () => {
    const w = mount(StepsList, { props: { steps: [{ t: 'Install `brew`' }, { t: 'Run it', cmd: 'brew upgrade fleet-agent' }, { t: 'Or do this', or: true }, { t: 'Then restart' }] } });
    expect(w.findAll('.sn').map(s => s.text())).toEqual(['1', '2', 'or', '3']);
    expect(w.findAll('li')[2]!.classes()).toContain('is-or');
    expect(w.find('.cmd code').text()).toBe('brew upgrade fleet-agent');
    expect(w.find('p code').text()).toBe('brew');
  });
  it('ChipsFilter is a group of toggle buttons', async () => {
    const w = mount(ChipsFilter, { props: { modelValue: 'open', label: 'Filter problems by state', items: [['open', 'Open', 3], ['snoozed', 'Snoozed', 0], ['all', 'All']] } });
    expect(w.attributes('role')).toBe('group');
    expect(w.attributes('aria-label')).toBe('Filter problems by state');
    expect(w.findAll('button').map(b => b.attributes('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(w.findAll('button')[0]!.find('span').text()).toBe('3');
    expect(w.findAll('button')[2]!.find('span').exists()).toBe(false);
    await w.findAll('button')[1]!.trigger('click');
    expect(w.emitted('update:modelValue')![0]).toEqual(['snoozed']);
  });
  it('Segbar and Legend show every state with value, icon and word; widths are set through the DOM', async () => {
    const parts = stateParts({ succeeded: 3, failed: 1 });
    const bar = mount(Segbar, { props: { parts, label: 'Rollout a3f9c21', size: 'sm' } });
    expect(bar.classes()).toEqual(expect.arrayContaining(['segbar', 'segbar--sm']));
    expect(bar.attributes('role')).toBe('img');
    expect(bar.attributes('aria-label')).toBe('Rollout a3f9c21: 3 Succeeded, 1 Failed');
    expect(bar.findAll('.seg')).toHaveLength(2);
    expect((bar.findAll('.seg')[0]!.element as HTMLElement).style.flexGrow).toBe('3');
    expect(bar.findAll('.seg')[0]!.attributes('style')).not.toContain('{');
    expect(bar.findAll('.seg')[0]!.attributes('data-tip')).toBe('3 assignments|Succeeded');
    expect(mount(Segbar, { props: { parts: stateParts({}), label: 'x' } }).attributes('aria-label')).toBe('x: none');
    const legend = mount(Legend, { props: { parts, clickable: true } });
    expect(legend.findAll('li')).toHaveLength(5);
    expect(legend.findAll('button.lg-btn')).toHaveLength(2);
    expect(legend.findAll('.lg-item')).toHaveLength(3);
    expect(legend.find('li').text()).toBe('Succeeded3');
    await legend.find('button').trigger('click');
    expect(legend.emitted('pick')![0]).toEqual(['succeeded']);
    expect(mount(Legend, { props: { parts } }).findAll('button')).toHaveLength(0);
  });
  it('TabNav marks the current tab, shows counts and links', async () => {
    const h2 = await componentHarness();
    const w = mount(TabNav, {
      props: { label: 'studio-mini sections', current: 'problems', items: [{ key: 'overview', label: 'Overview', to: '/machines/studio-mini' }, { key: 'problems', label: 'Problems', to: '/machines/studio-mini/problems', count: 2, tone: 'critical' }] },
      global: h2.global,
    });
    expect(w.attributes('aria-label')).toBe('studio-mini sections');
    const links = w.findAll('a');
    expect(links.map(a => a.attributes('href'))).toEqual(['/machines/studio-mini', '/machines/studio-mini/problems']);
    expect(links.map(a => a.attributes('aria-current'))).toEqual([undefined, 'page']);
    expect(links[1]!.find('.tab-cnt').classes()).toContain('t-critical');
    expect(links[1]!.find('.tab-cnt').text()).toBe('2');
    expect(links[0]!.find('.tab-cnt').exists()).toBe(false);
    h2.cleanup();
  });
});

describe('clipboard', () => {
  const stubClipboard = (writeText: (t: string) => Promise<void>) => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
  };
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));

  it('CopyButton copies, confirms for 1.6 s and then goes back', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const w = mount(CopyButton, { props: { text: 'sha256:abc', label: 'Copy', ariaLabel: 'Copy digest' } });
    expect(w.attributes('aria-label')).toBe('Copy digest');
    expect(w.find('span').text()).toBe('Copy');
    await w.trigger('click');
    await settle();
    expect(writeText).toHaveBeenCalledWith('sha256:abc');
    expect(w.classes()).toContain('is-copied');
    expect(w.find('span').text()).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1600);
    expect(w.classes()).not.toContain('is-copied');
    expect(w.find('span').text()).toBe('Copy');
  });
  it('an icon-only CopyButton has no text but keeps its name', async () => {
    stubClipboard(async () => undefined);
    const w = mount(CopyButton, { props: { text: 'x' } });
    expect(w.attributes('aria-label')).toBe('Copy to clipboard');
    expect(w.find('span').exists()).toBe(false);
  });
  it('CopyBox shows the command as text and copies it exactly', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const cmd = `echo "${XSS}"\nsecond line`;
    const w = mount(CopyBox, { props: { cmd } });
    expect(w.find('pre code').text()).toBe(cmd);
    noInjected(w.element);
    await w.find('button').trigger('click');
    await settle();
    expect(writeText).toHaveBeenCalledWith(cmd);
    expect(w.find('button span').text()).toBe('Copied');
  });
  it('falls back to a hidden textarea and execCommand when the Clipboard API is missing, and says what to do when that fails', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    const w = mount(CopyBox, { props: { cmd: 'brew upgrade fleet-agent' }, attachTo: document.body });
    await w.find('button').trigger('click');
    await settle();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    expect(w.find('button span').text()).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1600);
    exec.mockReturnValue(false);
    await w.find('button').trigger('click');
    await settle();
    expect(w.find('button span').text()).toBe('Press Ctrl+C');
    expect(w.classes()).not.toContain('is-copied');
    w.unmount();
  });
  it('falls back when writeText rejects (no permission)', async () => {
    stubClipboard(async () => { throw new Error('denied'); });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    const w = mount(CopyButton, { props: { text: 'x', label: 'Copy' } });
    await w.trigger('click');
    await settle();
    expect(exec).toHaveBeenCalled();
    expect(w.find('span').text()).toBe('Copied');
  });
});

describe('scope gating', () => {
  it('ScopeButton is a normal button with the right scope and a locked, explaining one without it', async () => {
    const operate = await componentHarness({ scope: 'operate' });
    const onClick = vi.fn();
    const ok = mount(ScopeButton, { props: { level: 'operate', cls: 'btn-primary' }, attrs: { onClick, 'data-act': 'sync' }, slots: { default: () => 'Sync repository' }, global: operate.global });
    expect(ok.classes()).toEqual(['btn', 'btn-primary']);
    expect(ok.attributes('data-act')).toBe('sync');
    expect(ok.attributes('aria-disabled')).toBeUndefined();
    await ok.trigger('click');
    expect(onClick).toHaveBeenCalledTimes(1);

    const locked = mount(ScopeButton, { props: { level: 'admin', cls: 'btn-primary' }, attrs: { onClick }, slots: { default: () => 'Add machine' }, global: operate.global });
    expect(locked.classes()).toEqual(expect.arrayContaining(['btn', 'btn-primary', 'is-locked']));
    expect(locked.attributes('aria-disabled')).toBe('true');
    expect(locked.attributes('disabled')).toBeUndefined();
    expect(locked.attributes('data-need')).toBe('admin');
    expect(locked.attributes('data-tip')).toBe('Not available|Needs the admin scope. Your account has operate access.');
    await locked.trigger('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(operate.ctx.toasts.items).toHaveLength(1);
    expect(operate.ctx.toasts.items[0]).toMatchObject({ title: 'Not available', tone: 'warning', text: 'Needs the admin scope. Your account has operate access.' });
    expect(operate.mock.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    operate.cleanup();
  });
  it('LockNote and ScopeGate follow the scope', async () => {
    const read = await componentHarness({ scope: 'read' });
    expect(mount(LockNote, { props: { level: 'admin' }, global: read.global }).text()).toBe('Needs the admin scope. Your account has read access.');
    expect(mount(LockNote, { props: { level: 'read' }, global: read.global }).find('p').exists()).toBe(false);
    const gate = (level: 'read' | 'operate') => mount(ScopeGate, { props: { level }, slots: { default: () => 'allowed', locked: () => 'locked' }, global: read.global });
    expect(gate('read').text()).toBe('allowed');
    expect(gate('operate').text()).toBe('locked');
    read.cleanup();
  });
});

describe('attempt detail', () => {
  it('FailureDetail shows step, path with the Target base and the diagnostic, each with a copy button', () => {
    const w = mount(FailureDetail, {
      props: { src: { diagnostic: 'trailing comma\nline 2', path: '.claude/settings.json', step: 'configure' }, target: { base: 'home', path: '.claude' } },
    });
    expect(w.find('.stepchip').text()).toBe('StepConfiguring');
    expect(w.find('.stepchip').attributes('data-step')).toBe('configure');
    expect(w.find('.fdetail-path code').text()).toBe('~/.claude/settings.json');
    expect(w.find('.fdetail-path button').attributes('aria-label')).toBe('Copy failing path');
    expect(w.find('.fdetail-path button').attributes('data-copy')).toBe('~/.claude/settings.json');
    expect(w.find('pre.code--diag').text()).toBe('trailing comma\nline 2');
    expect(w.find('.fdetail-diag button').attributes('data-copy')).toBe('trailing comma\nline 2');
    expect(w.find('.fdetail-none').exists()).toBe(false);
  });
  it('says so quietly when an old Agent sent nothing; a step alone is enough', () => {
    expect(mount(FailureDetail, { props: { src: { diagnostic: null, path: null, step: null } } }).find('.fdetail-none').text()).toBe('No detail reported. Agents before 0.9.0 send only the error code.');
    expect(mount(FailureDetail, { props: { src: undefined } }).find('.fdetail-none').exists()).toBe(true);
    const stepOnly = mount(FailureDetail, { props: { src: { step: 'lock' } } });
    expect(stepOnly.find('.stepchip').text()).toBe('StepTaking the lock');
    expect(stepOnly.find('.fdetail-path').exists()).toBe(false);
    expect(stepOnly.find('.fdetail-diag').exists()).toBe(false);
  });
  it('hostile diagnostic, path and step are text', () => {
    const w = mount(FailureDetail, { props: { src: { diagnostic: XSS, path: XSS, step: XSS } } });
    noInjected(w.element);
    expect(w.find('pre').text()).toBe(XSS);
    expect(w.find('.fdetail-path code').text()).toBe(XSS);
  });
  it('DiagLine: short text is a plain line; long or multi-line text is a details element that remembers it was opened', async () => {
    const h2 = await componentHarness();
    const short = mount(DiagLine, { props: { text: 'short', openKey: 'a' }, global: h2.global });
    expect(short.find('p.diag-line--short').text()).toBe('short');
    const long = mount(DiagLine, { props: { text: 'x'.repeat(91), openKey: 'b', cls: 'tl-text' }, global: h2.global, attachTo: document.body });
    expect(long.find('details.diag-line').classes()).toContain('tl-text');
    expect(long.find('summary .diag-text').text()).toBe('x'.repeat(91));
    expect(mount(DiagLine, { props: { text: 'a\nb', openKey: 'c' }, global: h2.global }).find('details').exists()).toBe(true);
    const el = long.find('details').element as HTMLDetailsElement;
    el.open = true;
    el.dispatchEvent(new Event('toggle'));
    expect(h2.ctx.openState.get('diag:b')).toBe(true);
    long.unmount();
    const again = mount(DiagLine, { props: { text: 'x'.repeat(91), openKey: 'b' }, global: h2.global });
    expect((again.find('details').element as HTMLDetailsElement).open).toBe(true);
    expect(mount(DiagLine, { props: { text: null, openKey: 'd' }, global: h2.global }).html()).toBe('<!--v-if-->');
    h2.cleanup();
  });
  it('FileList shows a count and the paths as text', async () => {
    const h2 = await componentHarness();
    const w = mount(FileList, { props: { files: ['a/SKILL.md', XSS], openKey: 'k' }, global: h2.global });
    expect(w.find('summary span').text()).toBe('2 files');
    expect(w.findAll('li code').map(c => c.text())).toEqual(['a/SKILL.md', XSS]);
    noInjected(w.element);
    expect(mount(FileList, { props: { files: ['one'], openKey: 'k2' }, global: h2.global }).find('summary span').text()).toBe('1 file');
    h2.cleanup();
  });
  it('Timeline groups events by day, shows time, step, text and files', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-25T14:30:00Z'));
    const h2 = await componentHarness();
    const w = mount(Timeline, {
      global: h2.global,
      props: { events: [
        { at: '2026-10-25T13:00:00Z', level: 'critical', kind: 'x', title: 'Skills failed', sub: 'rev a3f9c21', step: 'verify', text: 'bundle mismatch' },
        { at: '2026-10-25T09:00:00Z', level: 'info', kind: 'sync', title: 'Drift repaired', files: ['a.md', 'b.md'] },
        { at: '2026-10-24T09:00:00Z', level: 'good', kind: 'check', title: XSS },
      ] },
    });
    expect(w.findAll('.tl-day h3').map(x => x.text())).toEqual(['Today', 'Yesterday']);
    const first = w.findAll('.tl-item')[0]!;
    expect(first.find('.tl-top b').text()).toBe('Skills failed');
    expect(first.find('time').text()).toBe('13:00');
    expect(first.find('time').attributes('datetime')).toBe('2026-10-25T13:00:00Z');
    expect(first.find('.tl-sub').text()).toContain('rev a3f9c21');
    expect(first.find('.stepchip').text()).toContain('Verifying');
    expect(first.find('.tl-dot svg.g').exists()).toBe(true);
    expect(w.findAll('.tl-item')[1]!.find('.tl-files summary').text()).toBe('2 files');
    noInjected(w.element);
    expect(mount(Timeline, { props: { events: [] }, global: h2.global }).find('.empty-mini').text()).toBe('Nothing to show here.');
    h2.cleanup();
  });
});

describe('issues and revisions', () => {
  const issue = (over: Partial<Issue> = {}): Issue => ({ id: 'assignment_failed:n:skills', code: 'assignment_failed', severity: 'error', title: 't', detail: 'd', action: 'a', section: 'nodes', errorCode: null, nodeId: 'n', nodeName: 'studio-mini', target: 'skills', since: null, commands: [], ...over });
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-10-25T14:30:00Z')); });

  it('IssueBanner: nothing for open, who and when for acknowledged and snoozed', () => {
    expect(mount(IssueBanner, { props: { issue: issue() } }).html()).toBe('<!--v-if-->');
    const ack = mount(IssueBanner, { props: { issue: issue({ state: 'acknowledged', stateBy: 'ana', stateAt: '2026-10-25T12:30:00Z' }) } });
    expect(ack.classes()).toContain('prob-state--ack');
    expect(ack.text()).toBe('Acknowledged by ana, 2 h ago. It stays listed here and comes back to Open if it starts over.');
    const snoozed = mount(IssueBanner, { props: { issue: issue({ state: 'snoozed', stateBy: 'joan', stateAt: '2026-10-25T14:10:00Z', snoozedUntil: '2026-10-25T17:40:00Z' }) } });
    expect(snoozed.classes()).toContain('prob-state--snoozed');
    expect(snoozed.text()).toBe('Snoozed by joan, 20 min ago. Back in Open at Oct 25, 17:40 UTC (in 3 h 10 min). It stays listed here until then.');
    expect(mount(IssueBanner, { props: { issue: issue({ state: 'acknowledged', stateBy: XSS }) } }).element.querySelector('img')).toBeNull();
  });

  it('IssueActions: Acknowledge and four snooze lengths for an open problem, Reopen otherwise; they emit and do not call the API', async () => {
    const op = await componentHarness({ scope: 'operate' });
    const open = mount(IssueActions, { props: { issue: issue() }, global: op.global });
    expect(open.find('[data-op=acknowledge]').text()).toBe('Acknowledge');
    expect(open.findAll('[data-op=snooze]').map(b => [b.text(), b.attributes('aria-label')])).toEqual([['1 h', 'Snooze for 1 hour'], ['4 h', 'Snooze for 4 hours'], ['24 h', 'Snooze for 24 hours'], ['7 d', 'Snooze for 7 days']]);
    expect(open.find('.snooze').attributes('role')).toBe('group');
    await open.find('[data-op=acknowledge]').trigger('click');
    await open.findAll('[data-op=snooze]')[2]!.trigger('click');
    expect(open.emitted('state')).toEqual([[{ id: 'assignment_failed:n:skills', op: 'acknowledge' }], [{ id: 'assignment_failed:n:skills', op: 'snooze', hours: 24 }]]);
    await open.setProps({ busy: true });
    expect(open.findAll('button').every(b => b.attributes('disabled') !== undefined)).toBe(true);
    const snoozed = mount(IssueActions, { props: { issue: issue({ state: 'snoozed', snoozedUntil: '2026-10-25T17:40:00Z' }) }, global: op.global });
    expect(snoozed.findAll('button')).toHaveLength(1);
    await snoozed.find('[data-op=reopen]').trigger('click');
    expect(snoozed.emitted('state')![0]).toEqual([{ id: 'assignment_failed:n:skills', op: 'reopen' }]);
    expect(op.mock.calls.filter(c => c.method === 'POST')).toHaveLength(0);
    op.cleanup();
  });

  it('IssueActions with the read scope shows locked buttons and sends nothing', async () => {
    const read = await componentHarness({ scope: 'read' });
    const w = mount(IssueActions, { props: { issue: issue() }, global: read.global });
    expect(w.findAll('button.is-locked').map(b => b.text())).toEqual(['Acknowledge', 'Snooze']);
    expect(w.findAll('button').every(b => b.attributes('aria-disabled') === 'true')).toBe(true);
    await w.findAll('button')[0]!.trigger('click');
    expect(w.emitted('state')).toBeUndefined();
    expect(read.ctx.toasts.items[0]!.title).toBe('Not available');
    const reopen = mount(IssueActions, { props: { issue: issue({ state: 'acknowledged' }) }, global: read.global });
    expect(reopen.find('button.is-locked').text()).toBe('Reopen');
    read.cleanup();
  });

  it('ChangeChips: + ~ − signs, names as text, Target counts', () => {
    const w = mount(ChangeChips, { props: { detail: { skills: { added: ['incident-runbook'], changed: [XSS], removed: ['old'] }, targets: { added: 2, changed: 5, removed: 0, nodes: 4 } } } });
    expect(w.findAll('.chg').map(c => [c.classes()[1], c.find('.chg-s').text(), c.find('.chg-s').attributes('aria-label')])).toEqual([['chg--add', '+', 'added'], ['chg--mod', '~', 'changed'], ['chg--rm', '−', 'removed']]);
    expect(w.findAll('.chg')[1]!.text()).toBe(`~${XSS}`);
    noInjected(w.element);
    expect(w.find('.chg-targets').text()).toBe('Targets: 2 added · 5 changed · 0 removed, on 4 machines');
    const none = mount(ChangeChips, { props: { detail: { skills: { added: [], changed: [], removed: [] }, targets: { added: 0, changed: 0, removed: 0, nodes: 0 } } } });
    expect(none.text()).toBe('No Skill changes.No Target changes.');
  });
});

describe('charts and art', () => {
  const buckets = (polls: number[]) => polls.map((p, i) => ({ hour: new Date(Date.UTC(2026, 9, 25, i)).toISOString(), polls: p }));

  it('CheckinStrip draws a bar per busy hour and shows the hour on hover', async () => {
    const w = mount(CheckinStrip, { props: { buckets: buckets([0, 5, 10, 0]) }, attachTo: document.body });
    expect(w.attributes('role')).toBe('img');
    expect(w.attributes('aria-label')).toContain('Check-ins in the last 4 hours: 15.');
    expect(w.findAll('path.sb')).toHaveLength(2);
    expect(w.findAll('rect.sb0')).toHaveLength(2);
    vi.spyOn(w.element, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 100, width: 240, height: 24, right: 240, bottom: 124, x: 0, y: 100, toJSON: () => ({}) });
    await w.trigger('pointermove', { clientX: 130 });
    expect(tooltip.visible).toBe(true);
    expect(tooltip.head).toBe('10 check-ins');
    expect(tooltip.label).toBe('02:00–03:00 UTC');
    expect(w.find('path.sb.on').exists()).toBe(true);
    await w.trigger('pointerleave');
    expect(tooltip.visible).toBe(false);
    expect(w.find('.on').exists()).toBe(false);
    w.unmount();
  });

  it('CheckinChart is focusable and reads each hour with the arrow keys, Home and End', async () => {
    const w = mount(CheckinChart, { props: { buckets: buckets([2, 0, 7, 3, 0]) }, attachTo: document.body });
    expect(w.attributes('tabindex')).toBe('0');
    expect(w.attributes('role')).toBe('img');
    expect(w.attributes('aria-label')).toContain('Use the arrow keys to read each hour.');
    vi.spyOn(w.element, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 720, height: 152, right: 720, bottom: 152, x: 0, y: 0, toJSON: () => ({}) });
    const visibility = () => w.find('line.xh').attributes('visibility');
    expect(visibility()).toBe('hidden');
    await w.trigger('focus');
    expect(visibility()).toBe('visible');
    expect(tooltip.head).toBe('No check-ins');
    expect(w.find('.on').attributes('data-i')).toBe('4');
    await w.trigger('keydown', { key: 'ArrowLeft' });
    expect(tooltip.head).toBe('3 check-ins');
    await w.trigger('keydown', { key: 'Home' });
    expect(tooltip.head).toBe('2 check-ins');
    await w.trigger('keydown', { key: 'ArrowLeft' });
    expect(tooltip.head).toBe('2 check-ins');
    await w.trigger('keydown', { key: 'End' });
    expect(w.find('.on').attributes('data-i')).toBe('4');
    await w.trigger('keydown', { key: 'ArrowRight' });
    expect(w.find('.on').attributes('data-i')).toBe('4');
    await w.trigger('keydown', { key: 'a' });
    await w.trigger('blur');
    expect(visibility()).toBe('hidden');
    expect(tooltip.visible).toBe(false);
    w.unmount();
  });

  it('CheckinChart handles an empty window', () => {
    const w = mount(CheckinChart, { props: { buckets: [] } });
    expect(w.findAll('path.cb, rect.cb0')).toHaveLength(0);
  });

  it('GapList names gaps or says there are none', () => {
    expect(mount(GapList, { props: { buckets: buckets([1, 0, 0, 1]) } }).find('li span').text()).toBe('No check-ins 01:00–03:00 UTC (2 h), Oct 25.');
    expect(mount(GapList, { props: { buckets: buckets([1, 1]) } }).find('.gaps-none').text()).toBe('No gaps longer than an hour.');
    expect(mount(GapList, { props: { buckets: [] } }).html()).toBe('<!--v-if-->');
    expect(mount(GapList, { props: { buckets: buckets([0, 0]), revoked: true } }).text()).toContain('revoked');
  });

  it('DeviceArt: a laptop for macOS, a desktop for Linux, dimmed when not checking in, with an honest name', () => {
    const mac = mount(DeviceArt, { props: { node: { revoked: false, freshness: 'fresh', platform: 'macos' }, health: { level: 'good' } } });
    expect(mac.classes()).toEqual(expect.arrayContaining(['dev', 'dev--on']));
    expect(mac.attributes('role')).toBe('img');
    expect(mac.attributes('aria-label')).toBe('macOS machine');
    expect(mac.find('rect[fill="url(#wpMac)"]').exists()).toBe(true);
    const linux = mount(DeviceArt, { props: { node: { revoked: false, freshness: 'fresh', platform: 'linux' }, health: { level: 'critical' } } });
    expect(linux.find('circle').attributes('stroke')).toBe('#ff6b5b');
    expect(linux.findAll('rect[fill="#000"][opacity=".28"]')).toHaveLength(6);
    expect(mount(DeviceArt, { props: { node: { revoked: false, freshness: 'stale', platform: 'macos' } } }).attributes('aria-label')).toBe('macOS machine, not checking in');
    expect(mount(DeviceArt, { props: { node: { revoked: false, freshness: 'stale', platform: 'macos' } } }).find('.zz').exists()).toBe(true);
    expect(mount(DeviceArt, { props: { node: { revoked: false, freshness: 'never_contacted', platform: 'linux' } } }).attributes('aria-label')).toBe('Linux machine, has not checked in yet');
    const off = mount(DeviceArt, { props: { node: { revoked: true, freshness: 'fresh', platform: 'linux' } } });
    expect(off.classes()).toContain('dev--off');
    expect(off.attributes('aria-label')).toBe('Linux machine, revoked');
    expect(mount(DeviceArt, { props: { node: { revoked: false, freshness: 'fresh', platform: 'plan9' } } }).find('rect[fill="url(#wpOther)"]').exists()).toBe(true);
  });
});

describe('countdowns', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(Date.parse('2026-10-25T14:30:00Z')); });

  it('Countdown ticks every second and stops ticking after unmount', async () => {
    const to = '2026-10-25T14:30:50Z';
    const w = mount(Countdown, { props: { to } });
    expect(w.text()).toBe('in 50 s');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(w.text()).toBe('in 39 s');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(w.text()).toBe('expired');
    w.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clock format and the meter width', async () => {
    const clock = mount(Countdown, { props: { to: '2026-10-25T14:35:00Z', fmt: 'clock' } });
    expect(clock.text()).toBe('5:00');
    const bar = mount(CountdownBar, { props: { to: '2026-10-25T14:35:00Z', totalMs: 600_000 } });
    expect((bar.element as HTMLElement).style.width).toBe('50.00%');
    await vi.advanceTimersByTimeAsync(150_000);
    expect((bar.element as HTMLElement).style.width).toBe('25.00%');
    await vi.advanceTimersByTimeAsync(400_000);
    expect((bar.element as HTMLElement).style.width).toBe('0.00%');
  });
});
