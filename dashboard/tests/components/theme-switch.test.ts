import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ThemeSwitch from '@/components/ThemeSwitch.vue';
import { THEME_STORAGE_KEY, initTheme, resetTheme } from '@/theme';

describe('ThemeSwitch', () => {
  beforeEach(() => {
    resetTheme();
    localStorage.clear();
    initTheme();
  });
  afterEach(() => {
    resetTheme();
    localStorage.clear();
  });

  it('shows the three themes with dark pressed by default', () => {
    const wrapper = mount(ThemeSwitch);
    const buttons = wrapper.findAll('button');
    expect(wrapper.get('[role=group]').attributes('aria-label')).toBe('Theme');
    expect(buttons.map(b => b.text())).toEqual(['Dark', 'Light', 'System']);
    expect(buttons.map(b => b.attributes('aria-pressed'))).toEqual(['true', 'false', 'false']);
  });

  it('switches and stores the theme', async () => {
    const wrapper = mount(ThemeSwitch);
    await wrapper.get('[data-theme-option=light]').trigger('click');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(wrapper.get('[data-theme-option=light]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-theme-option=dark]').attributes('aria-pressed')).toBe('false');
  });

  it('keeps an accessible name for every button when compact', () => {
    const wrapper = mount(ThemeSwitch, { props: { compact: true } });
    expect(wrapper.classes()).toContain('theme-switch--compact');
    for (const button of wrapper.findAll('button')) {
      expect(button.text()).toBe('');
      expect(button.attributes('aria-label')).toMatch(/^(Dark|Light|System) theme$/);
    }
  });
});
