import { test, expect } from '../support/fixtures';
import { productionCsp } from '../support/csp';
import { open } from '../support/app';

/**
 * The fixture rules (`support/guard.ts`) are only worth something if they notice. Each test below makes the page misbehave and
 * allows exactly that: a rule that did not notice leaves its allowance unused, which fails the test.
 */
test.describe('the fixture notices', () => {
  test('console errors and warnings', async ({ page, allow }) => {
    allow.console(/^error: boom-error/);
    allow.console(/^warning: boom-warning/);
    await open(page, '/machines');
    await page.evaluate(() => { console.error('boom-error'); console.warn('boom-warning'); console.log('plain logs are fine'); });
  });

  test('uncaught exceptions and unhandled rejections', async ({ page, allow }) => {
    allow.pageError(/kaboom-throw/);
    allow.pageError(/kaboom-reject/);
    await open(page, '/machines');
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('kaboom-throw'); });
      void Promise.reject(new Error('kaboom-reject'));
    });
    await expect.poll(() => allow.seen.filter(o => o.kind === 'pageerror').length).toBe(2);
  });

  test('Content-Security-Policy violations: inline script, inline style and a request to another origin', async ({ page, allow }) => {
    allow.csp(/script-src/);
    allow.csp(/style-src/);
    allow.csp(/connect-src/);
    allow.csp(/Refused to connect/); // Chromium's own console report of the same violation
    await open(page, '/machines');
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__inline = true';
      document.head.append(script);
      document.body.insertAdjacentHTML('beforeend', '<p style="color: red">inline style</p>');
      void fetch('https://example.invalid/steal').catch(() => undefined);
    });
    await expect.poll(() => allow.seen.filter(o => o.kind === 'csp').length).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => (window as unknown as { __inline?: boolean }).__inline)).toBeUndefined();
  });

  test('failed requests and error responses', async ({ page, allow }) => {
    allow.request(/GET \S+\/gone\.js -> 404/);
    allow.request(/GET \S+\/unreachable\.js net::ERR_FAILED/);
    allow.console(/404/);
    allow.console(/unreachable\.js/);
    await page.route('**/gone.js', route => route.fulfill({ status: 404, body: 'gone' }));
    await page.route('**/unreachable.js', route => route.abort('failed'));
    await open(page, '/machines');
    await page.evaluate(() => { void fetch('/gone.js'); void fetch('/unreachable.js').catch(() => undefined); });
    await expect.poll(() => allow.seen.filter(o => o.kind === 'request').length).toBe(2);
  });
});

test.describe('the preview serves the dashboard as the container does', () => {
  test('with the production Content-Security-Policy and security headers, and no inline code', async ({ page }) => {
    const response = await page.goto('/machines');
    const headers = response?.headers() ?? {};
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toBe(productionCsp());
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"]) expect(csp).toContain(directive);
    expect(csp).not.toMatch(/unsafe-(inline|eval)|data:|\*/);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    // No inline code in the HTML itself (Vue sets some styles through the DOM, which the policy allows).
    const html = (await response?.text()) ?? '';
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)|<style|\sstyle=|\sonclick=/i);
  });
});
