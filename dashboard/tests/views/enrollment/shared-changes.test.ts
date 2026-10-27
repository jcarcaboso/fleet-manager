/** The small additive changes to shared components that the Machines and Enrollment pages needed. */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import Legend from '@/components/Legend.vue';
import Modal from '@/components/Modal.vue';
import Segbar from '@/components/Segbar.vue';

describe('Segbar and Legend with parts that are not Assignment states', () => {
  const parts = [
    { key: 'ok', label: 'Up to date', level: 'good', kind: 'check', value: 2, unit: 'machines', tip: 'a, b' },
    { key: 'failing', label: 'Action needed', level: 'critical', kind: 'bang', value: 1, unit: 'machine' },
  ] as const;

  it('a part may carry a tooltip row (the names behind a segment)', () => {
    const bar = mount(Segbar, { props: { parts: [...parts], label: 'Machines by health' } });
    const segs = bar.findAll('.seg');
    expect(segs[0]!.attributes('data-tip')).toBe('2 machines|Up to date\na, b');
    expect(segs[1]!.attributes('data-tip')).toBe('1 machine|Action needed');
  });

  it('the legend emits the key of the part that was picked', async () => {
    const legend = mount(Legend, { props: { parts: [...parts], clickable: true } });
    await legend.findAll('button')[1]!.trigger('click');
    expect(legend.emitted('pick')).toEqual([['failing']]);
  });
});

describe('Modal with a bare body and a custom head', () => {
  it('passes the title ID to the head slot, labels the dialog with it, and skips the padded body wrapper when bare', () => {
    const root = document.createElement('div');
    root.id = 'modal-root';
    document.body.append(root);
    const Host = defineComponent({
      setup: () => () => h(Modal, { title: 'T', bare: true }, {
        head: (p: { titleId: string }) => h('div', { class: 'modal-head' }, h('h2', { id: p.titleId }, 'Custom')),
        default: () => h('div', { class: 'content' }, 'x'),
      }),
    });
    const w = mount(Host, { attachTo: document.body });
    const dialog = document.querySelector('.modal')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2')!.id);
    expect(dialog.querySelector('.modal-body')).toBeNull();
    expect(dialog.querySelector(':scope > .content')).not.toBeNull();
    w.unmount();
  });

  it('keeps the body wrapper by default', () => {
    const root = document.createElement('div');
    root.id = 'modal-root';
    document.body.append(root);
    const w = mount(Modal, { props: { title: 'T' }, slots: { default: '<p class="c">x</p>' }, attachTo: document.body });
    expect(document.querySelector('.modal > .modal-body > .c')).not.toBeNull();
    w.unmount();
  });
});
