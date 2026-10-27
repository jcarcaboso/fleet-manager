import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installKeepFocus } from '@/composables/keepFocus';

let stop: (() => void) | undefined;
let button: HTMLButtonElement;
let other: HTMLButtonElement;
beforeEach(() => {
  document.body.innerHTML = '<button id="a">Sync</button><button id="b">Other</button>';
  button = document.getElementById('a') as HTMLButtonElement;
  other = document.getElementById('b') as HTMLButtonElement;
  stop = installKeepFocus();
});
afterEach(() => { stop?.(); stop = undefined; });

/** What Chromium does to a focused button that becomes disabled: focus moves to <body>. */
async function disableLikeChromium(el: HTMLButtonElement): Promise<void> {
  el.disabled = true;
  await flushPromises(); // the observer has seen the focused button become disabled
  other.focus(); // happy-dom cannot blur a disabled button: move focus away and then to <body>
  other.blur();
}

describe('keepFocus: a button that was disabled while it had focus gets it back when it is enabled again', () => {
  it('restores the focus', async () => {
    button.focus();
    await disableLikeChromium(button);
    expect(document.activeElement).toBe(document.body);
    button.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(button);
  });

  it('works for the same button again and again', async () => {
    for (let i = 0; i < 3; i++) {
      button.focus();
      await disableLikeChromium(button);
      button.disabled = false;
      await flushPromises();
      expect(document.activeElement).toBe(button);
    }
  });

  it('does not take focus from an element that has it by then', async () => {
    button.focus();
    await disableLikeChromium(button);
    other.focus();
    button.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(other);
  });

  it('does not restore after the user pressed a key or the pointer in between', async () => {
    for (const type of ['keydown', 'pointerdown']) {
      button.disabled = false;
      button.focus();
      await disableLikeChromium(button);
      document.dispatchEvent(new Event(type, { bubbles: true }));
      button.disabled = false;
      await flushPromises();
      expect(document.activeElement, type).toBe(document.body);
    }
  });

  it('ignores a button that did not have focus, and one that left the page', async () => {
    other.focus();
    button.disabled = true;
    await flushPromises();
    button.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(other);

    other.blur();
    button.focus();
    await disableLikeChromium(button);
    button.remove();
    button.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(document.body);
  });

  it('stops observing when removed', async () => {
    stop!();
    stop = undefined;
    button.focus();
    await disableLikeChromium(button);
    button.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(document.body);
  });
});
