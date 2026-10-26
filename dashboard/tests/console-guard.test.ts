/** The guard in `tests/setup.ts`: console.error, console.warn and Vue warnings fail the test that caused them unless it expects them. */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, inject } from 'vue';
import { expectConsole, installConsoleGuard, removeConsoleGuard } from './helpers/console';

describe('console guard', () => {
  it('records console.error and console.warn instead of printing them, and expectConsole() declares them expected', () => {
    const logged = expectConsole('error', 'warn');
    console.error('boom', new Error('bad'), { a: 1 });
    console.warn('careful');
    expect(logged.error).toEqual(['boom Error: bad {"a":1}']);
    expect(logged.warn).toEqual(['careful']);
  });

  it('a Vue warning is recorded as a warning (config.global.config.warnHandler of @vue/test-utils)', () => {
    const logged = expectConsole('warn');
    const Probe = defineComponent({ setup() { inject('nobody-provides-this'); return () => h('div'); } });
    mount(Probe);
    expect(logged.warn.some(m => m.startsWith('[Vue warn]') && m.includes('nobody-provides-this'))).toBe(true);
  });

  it('what a test did not declare is reported to the setup file, and a declared level is not', () => {
    /* A fresh guard, made with the same functions `tests/setup.ts` uses around each test. */
    removeConsoleGuard();
    installConsoleGuard();
    console.error('undeclared');
    console.warn('declared below');
    expectConsole('warn');
    expect(removeConsoleGuard()).toEqual(['console.error: undeclared']);
    installConsoleGuard(); // so that the afterEach of tests/setup.ts has a guard to remove
  });
});
