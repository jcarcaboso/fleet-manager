import { afterEach, describe, expect, it } from 'vitest';
import { mountApp, textOf, type TestApp } from '../helpers/app';

let app: TestApp | undefined;
afterEach(() => app?.unmount());

describe('app smoke', () => {
  it('shows the machines page when the mock session is signed in', async () => {
    app = await mountApp();
    expect(app.router.currentRoute.value.name).toBe('machines');
    expect(app.wrapper.find('#view h1').text()).toContain('machines are up to date');
  });
});
