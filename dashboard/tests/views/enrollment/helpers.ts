import { flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';
import { mountApp, waitFor, type MountOptions, type TestApp } from '../../helpers/app';

export const $ = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [...document.querySelectorAll<T>(sel)];

/** Types into an input the way a user does: sets the value and fires `input`. */
export function type(el: HTMLInputElement | null, value: string): void {
  if (!el) throw new Error('no input to type into');
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
  await flushPromises();
}
export async function submit(form: Element | null): Promise<void> {
  if (!form) throw new Error('no form');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
}
export const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await flushPromises(); };

/** The mock with fake timers, on a page that has the Add machine button (the gallery by default). */
export async function openApp(options: MountOptions = {}): Promise<TestApp> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const app = await mountApp({ path: '/machines', ...options });
  await waitFor(() => $('.health') || $('.empty') || $('.panel'));
  return app;
}
export const modalText = (): string => ($('.modal')?.textContent ?? '').replace(/\s+/g, ' ').trim();
export const linkReads = (app: TestApp): number => app.mock.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path) && c.method === 'GET').length;
export const nodeReads = (app: TestApp, alias: string): number => app.mock.calls.filter(c => c.path.startsWith(`nodes/${alias}`)).length;
export const addButton = (): HTMLElement => $$('.btn-primary').find(b => /Add machine/.test(b.textContent ?? ''))!;

/** Opens the wizard from the page's Add machine button, names the machine and creates the link (step 2). */
export async function toStep2(alias: string): Promise<void> {
  await click(addButton());
  await waitFor(() => $('#wz-alias'));
  type($<HTMLInputElement>('#wz-alias'), alias);
  await submit($('form[data-form=wz]'));
  await waitFor(() => $('.wz-link'));
}
/** Continues to step 3 ("I have run these commands"). */
export async function toStep3(alias: string): Promise<void> {
  await toStep2(alias);
  await click($('[data-act=wz-wait]'));
  await waitFor(() => $('.wz-3'));
}
