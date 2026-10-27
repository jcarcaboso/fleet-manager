import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Modal from '@/components/Modal.vue';
import ToastHost from '@/components/ToastHost.vue';
import { modalOpenCount } from '@/composables/modalStack';
import { createToasts } from '@/composables/toasts';
import { settle, componentHarness } from '../helpers/app';

/** A page with a trigger button, so focus can return to it. */
function page(modal: () => ReturnType<typeof h>) {
  const open = ref(false);
  const closed = vi.fn();
  const wrapper = mount(defineComponent({
    setup: () => () => h('div', [
      h('button', { id: 'trigger', onClick: () => { open.value = true; } }, 'Open'),
      h('input', { id: 'outside' }),
      open.value ? h(Modal, { title: 'Revoke access', subtitle: 'Sub', icon: 'ban', tone: 'serious', onClose: () => { closed(); open.value = false; } }, {
        default: () => [h('p', 'Body'), h('input', { id: 'in-input' }), h('button', { id: 'in-button' }, 'Inside')],
        footer: () => [h('button', { id: 'cancel', 'data-autofocus': '' }, 'Cancel'), h('button', { id: 'confirm' }, 'Confirm')],
      }) : null,
      modal(),
    ]),
  }), { attachTo: document.body });
  return { wrapper, open, closed };
}

const press = (key: string, opts: KeyboardEventInit = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

describe('Modal', () => {
  let wrapper: ReturnType<typeof page>['wrapper'];
  afterEach(() => wrapper?.unmount());

  async function open() {
    const p = page(() => h('span'));
    wrapper = p.wrapper;
    $('#trigger').focus();
    await wrapper.find('#trigger').trigger('click');
    await settle();
    return p;
  }

  it('renders an accessible dialog labelled by its title, and locks page scroll', async () => {
    await open();
    const dialog = $('.modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const label = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(label)?.textContent).toBe('Revoke access');
    expect(dialog.querySelector('.modal-head p')?.textContent).toBe('Sub');
    expect(dialog.querySelector('.modal-ic.t-serious svg')).not.toBeNull();
    expect(dialog.querySelector('.icon-btn')?.getAttribute('aria-label')).toBe('Close');
    expect(document.body.classList.contains('has-modal')).toBe(true);
    expect(modalOpenCount.value).toBe(1);
  });

  it('moves focus to [data-autofocus]', async () => {
    await open();
    expect(document.activeElement?.id).toBe('cancel');
  });

  it('falls back to the first input, then a button that is not the close button', async () => {
    const p = page(() => h('span'));
    wrapper = p.wrapper;
    p.open.value = true;
    await settle();
    expect(document.activeElement?.id).toBe('cancel');
    wrapper.unmount();
    const bare = mount(Modal, { props: { title: 'T' }, slots: { default: () => [h('p', 'x'), h('input', { id: 'first' })] }, attachTo: document.body });
    await settle();
    expect(document.activeElement?.id).toBe('first');
    bare.unmount();
    const onlyClose = mount(Modal, { props: { title: 'T' }, slots: { default: () => h('p', 'x') }, attachTo: document.body });
    await settle();
    expect(document.activeElement?.classList.contains('icon-btn')).toBe(true);
    onlyClose.unmount();
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    await open();
    const order = ['#in-input', '#in-button', '#cancel', '#confirm'];
    $<HTMLElement>('.icon-btn').focus();
    expect(document.activeElement?.classList.contains('icon-btn')).toBe(true);
    /* Tab from the last control wraps to the first one (the close button). */
    $('#confirm').focus();
    press('Tab');
    expect(document.activeElement?.classList.contains('icon-btn')).toBe(true);
    /* Shift+Tab from the first control wraps to the last one. */
    press('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('confirm');
    /* Tab from the middle is left to the browser. */
    $(order[1]!).focus();
    const free = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
  });

  it('pulls focus back in when it is outside the dialog', async () => {
    await open();
    $('#outside').focus();
    press('Tab');
    expect(document.querySelector('.modal')?.contains(document.activeElement)).toBe(true);
    $('#outside').focus();
    press('Tab', { shiftKey: true });
    expect(document.querySelector('.modal')?.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and gives focus back to the element that opened it', async () => {
    const p = await open();
    press('Escape');
    await settle();
    expect(p.closed).toHaveBeenCalledTimes(1);
    expect($('.modal')).toBeNull();
    expect(document.activeElement?.id).toBe('trigger');
    expect(document.body.classList.contains('has-modal')).toBe(false);
    expect(modalOpenCount.value).toBe(0);
  });

  it('closes on the backdrop and on the close button', async () => {
    const p = await open();
    $('.modal-back').click();
    await settle();
    expect(p.closed).toHaveBeenCalledTimes(1);
    await wrapper.find('#trigger').trigger('click');
    await settle();
    $('.modal .icon-btn').click();
    await settle();
    expect(p.closed).toHaveBeenCalledTimes(2);
  });

  it('does not move focus back to an element that left the page', async () => {
    const p = await open();
    wrapper.find('#trigger').element.remove();
    p.open.value = false;
    await settle();
    expect(document.activeElement?.id).not.toBe('trigger');
  });

  it('only the topmost of two modals answers Escape', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = mount(Modal, { props: { title: 'A', onClose: first }, attachTo: document.body });
    const b = mount(Modal, { props: { title: 'B', onClose: second }, attachTo: document.body });
    await settle();
    press('Escape');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    b.unmount();
    press('Escape');
    expect(first).toHaveBeenCalledTimes(1);
    a.unmount();
  });

  it('a persistent modal ignores Escape and the backdrop', async () => {
    const onClose = vi.fn();
    const m = mount(Modal, { props: { title: 'Busy', persistent: true, onClose }, attachTo: document.body });
    await settle();
    press('Escape');
    $('.modal-back').click();
    expect(onClose).not.toHaveBeenCalled();
    m.unmount();
  });

  it('teleports into #modal-root when the shell provides it, else into the body', async () => {
    const root = document.createElement('div');
    root.id = 'modal-root';
    document.body.append(root);
    const m = mount(Modal, { props: { title: 'In root' }, attachTo: document.body });
    await settle();
    expect(root.querySelector('.modal')).not.toBeNull();
    m.unmount();
    root.remove();
    const m2 = mount(Modal, { props: { title: 'In body' }, attachTo: document.body });
    await settle();
    expect(document.body.querySelector(':scope > .modal')).not.toBeNull();
    m2.unmount();
  });
});

describe('ConfirmDialog', () => {
  it('confirms and cancels, with the right button styles', async () => {
    const wrapper = mount(ConfirmDialog, { props: { title: 'Revoke?', confirmLabel: 'Revoke access', confirmIcon: 'ban', danger: true }, slots: { default: () => h('p', 'This stops the Agent.') }, attachTo: document.body });
    await settle();
    expect(document.activeElement?.textContent).toBe('Cancel');
    const confirm = document.querySelector('.modal-foot .btn-danger') as HTMLButtonElement;
    expect(confirm.textContent).toContain('Revoke access');
    confirm.click();
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    (document.querySelector('.modal-foot .btn-secondary') as HTMLButtonElement).click();
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('with a phrase, the confirm button stays disabled until the alias matches exactly', async () => {
    const wrapper = mount(ConfirmDialog, { props: { title: 'Remove studio-mini?', confirmLabel: 'Remove machine', danger: true, confirmPhrase: 'studio-mini' }, attachTo: document.body });
    await settle();
    const input = document.querySelector('.modal input') as HTMLInputElement;
    const confirm = document.querySelector('.modal-foot .btn-danger') as HTMLButtonElement;
    const msg = document.querySelector('.field-msg') as HTMLElement;
    expect(document.activeElement).toBe(input);
    expect(confirm.disabled).toBe(true);
    expect(msg.textContent).toBe('The alias must match exactly, including case.');
    const type = async (v: string) => { input.value = v; input.dispatchEvent(new Event('input')); await nextTick(); };
    await type('studio');
    expect(msg.textContent).toBe('Keep typing…');
    expect(confirm.disabled).toBe(true);
    await type('Studio-mini');
    expect(msg.textContent).toBe('That does not match the alias.');
    expect(msg.classList.contains('is-err')).toBe(true);
    await type('studio-mini');
    expect(confirm.disabled).toBe(false);
    expect(msg.classList.contains('is-ok')).toBe(true);
    confirm.click();
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows a Server error inside the dialog and disables the buttons while busy', async () => {
    const wrapper = mount(ConfirmDialog, { props: { title: 'T', confirmLabel: 'Go', error: 'That machine has been revoked.' }, attachTo: document.body });
    await settle();
    expect(document.querySelector('.modal .field-msg.is-err')?.textContent).toBe('That machine has been revoked.');
    await wrapper.setProps({ busy: true });
    expect(Array.from(document.querySelectorAll('.modal-foot button')).every(b => (b as HTMLButtonElement).disabled)).toBe(true);
    wrapper.unmount();
  });
});

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a toast, fades it after 6 s and removes it after 6.4 s', async () => {
    const toasts = createToasts();
    const h = await componentHarness();
    h.ctx.toasts.push('Retry requested', { text: 'The Agent applies it on its next poll.' });
    const wrapper = mount(ToastHost, { global: h.global });
    await nextTick();
    const el = wrapper.find('.toast');
    expect(el.classes()).toContain('toast--good');
    expect(el.attributes('role')).toBe('status');
    expect(el.find('.toast-main b').text()).toBe('Retry requested');
    expect(el.find('.toast-main span').text()).toBe('The Agent applies it on its next poll.');
    expect(el.find('button').attributes('aria-label')).toBe('Dismiss');
    await vi.advanceTimersByTimeAsync(5999);
    expect(wrapper.find('.toast').classes()).not.toContain('out');
    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.find('.toast').classes()).toContain('out');
    await vi.advanceTimersByTimeAsync(400);
    expect(wrapper.find('.toast').exists()).toBe(false);
    expect(toasts.items).toHaveLength(0);
    wrapper.unmount();
    h.cleanup();
  });

  it('fail() shows errors as sticky critical toasts (warning for 403) and skips silent ones', async () => {
    const t = createToasts();
    t.fail({ status: 500, message: 'The Server had a problem (500).' }, 'Retry was not requested');
    t.fail({ status: 403, message: 'Needs scope' });
    t.fail({ silent: true, message: 'cancelled' });
    expect(t.items.map(i => [i.title, i.tone, i.text])).toEqual([['Retry was not requested', 'critical', 'The Server had a problem (500).'], ['That did not work', 'warning', 'Needs scope']]);
    vi.advanceTimersByTime(11_999);
    expect(t.items[0]!.out).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.items[0]!.out).toBe(true);
    vi.advanceTimersByTime(400);
    expect(t.items).toHaveLength(0);
  });

  it('dismiss removes one toast and its timers; critical toasts are alerts', async () => {
    const h = await componentHarness();
    const id = h.ctx.toasts.push('Boom', { tone: 'critical' });
    h.ctx.toasts.push('Fine');
    const wrapper = mount(ToastHost, { global: h.global });
    await nextTick();
    expect(wrapper.findAll('.toast')[0]!.attributes('role')).toBe('alert');
    await wrapper.findAll('.toast button')[0]!.trigger('click');
    expect(wrapper.findAll('.toast')).toHaveLength(1);
    h.ctx.toasts.dismiss(id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wrapper.findAll('.toast')).toHaveLength(0);
    wrapper.unmount();
    h.cleanup();
  });

  it('toast text is text, never markup', async () => {
    const h = await componentHarness();
    h.ctx.toasts.push('<img src=x onerror=alert(1)>', { text: '<script>alert(2)</script>' });
    const wrapper = mount(ToastHost, { global: h.global });
    await nextTick();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.find('.toast-main b').text()).toBe('<img src=x onerror=alert(1)>');
    wrapper.unmount();
    h.cleanup();
  });
});
