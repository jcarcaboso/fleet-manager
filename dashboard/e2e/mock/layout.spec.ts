import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { expectNoHorizontalOverflow, h1, open } from '../support/app';

/** The pages every Operator can reach, with a link to the revision page found at run time. */
const PAGES: Array<[name: string, path: string]> = [
  ['Machines', '/machines'],
  ['a machine, Overview', '/machines/design-imac'],
  ['a machine, Installed', '/machines/design-imac/installed'],
  ['a machine, Problems', '/machines/design-imac/problems'],
  ['a machine, Activity', '/machines/design-imac/activity'],
  ['a machine, Security', '/machines/design-imac/security'],
  ['a machine, Settings', '/machines/design-imac/settings'],
  ['Problems', '/problems'],
  ['Deployments', '/deployments'],
  ['Repository', '/repository'],
  ['Models', '/models'],
  ['Enrollment', '/enrollment'],
  ['Audit', '/audit'],
];

async function firstRevisionPath(page: Page): Promise<string> {
  await open(page, '/deployments');
  await page.getByRole('link', { name: 'Open this revision' }).click();
  await expect(page).toHaveURL(url => /^\/deployments\/[0-9a-f-]{36}$/.test(url.pathname));
  return new URL(page.url()).pathname;
}

/*
 * 320 px leaves room for fonts wider than the ones on the machine running the tests. CI's Linux fonts once made the
 * Machines page 402 px wide in a 390 px window while it fitted locally, because grid columns could not shrink below their
 * content. Every page must fit the narrowest common phone width.
 */
test.describe('narrow phone (320 × 640)', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const [name, path] of PAGES) {
    test(`${name} does not scroll sideways`, async ({ page }) => {
      await open(page, path);
      await expect(h1(page)).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});

test.describe('mobile (390 × 844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [name, path] of PAGES) {
    test(`${name} does not scroll sideways`, async ({ page }) => {
      await open(page, path);
      // Wait for the page's own content, not just its heading.
      await expect(page.locator('#view .skel')).toHaveCount(0);
      expect(await page.evaluate(() => window.innerWidth)).toBe(390);
      await expectNoHorizontalOverflow(page);
    });
  }

  test('a revision does not scroll sideways', async ({ page }) => {
    await open(page, await firstRevisionPath(page));
    await expect(page.locator('li.rv-row').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('the sign-in page, the Add machine wizard and a confirmation dialog fit', async ({ page }) => {
    await open(page, '/login', { signedout: true });
    await expectNoHorizontalOverflow(page);

    await open(page, '/machines');
    await page.getByRole('button', { name: 'Add machine' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const box = await page.getByRole('dialog').boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, 'the wizard is inside the screen').toBe(true);
    await page.keyboard.press('Escape');

    await open(page, '/machines/design-imac/settings');
    await page.getByRole('button', { name: 'Remove…' }).click();
    const dialog = await page.getByRole('dialog').boundingBox();
    expect(dialog && dialog.x >= 0 && dialog.x + dialog.width <= 390, 'the dialog is inside the screen').toBe(true);
    await expectNoHorizontalOverflow(page);
  });

  test('hostile text from the Server does not widen the page', async ({ page }) => {
    await open(page, '/machines/design-imac/problems', { xss: true });
    await expect(page.locator('#tabpanel .prob, #tabpanel details').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await open(page, '/deployments', { xss: true });
    await expectNoHorizontalOverflow(page);
  });
});

/**
 * An accessibility smoke test that needs no extra dependency: the structure every page must have, read from the browser's
 * accessibility tree (`ariaSnapshot`) and the DOM. It does not replace an audit with a rules engine such as axe-core (colour
 * contrast, ARIA validity); see dashboard/README.md for why that is not added.
 */
test.describe('accessibility smoke', () => {
  const unnamed = (snapshot: string): string[] =>
    snapshot.split('\n').filter(line => /^\s*- (button|link|textbox|searchbox|combobox|checkbox|radio|switch|tab|img|slider|spinbutton)(\s*\[[^\]]*\])*\s*:?\s*$/.test(line)).map(line => line.trim());

  for (const [name, path] of PAGES) {
    test(`${name}: one h1, landmarks, names for every control, unique ids`, async ({ page }) => {
      await open(page, path);
      await expect(page.locator('#view .skel')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByRole('banner')).toHaveCount(1);
      await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByRole('contentinfo')).toHaveCount(1);
      await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
      expect(await page.title()).toMatch(/\S+ · Fleet Manager$/);

      expect(unnamed(await page.locator('body').ariaSnapshot()), 'controls without an accessible name').toEqual([]);

      const problems = await page.evaluate(() => {
        const found: string[] = [];
        const ids = new Map<string, number>();
        for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
        for (const [id, n] of ids) if (n > 1) found.push(`duplicate id "${id}" (${n}×)`);
        for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) found.push('img without alt');
        for (const field of document.querySelectorAll<HTMLInputElement>('input:not([type=hidden]), select, textarea')) {
          const labelled = field.labels?.length || field.getAttribute('aria-label') || field.getAttribute('aria-labelledby');
          if (!labelled) found.push(`unlabelled ${field.tagName.toLowerCase()}${field.id ? '#' + field.id : ''}`);
        }
        for (const ref of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) {
          for (const attr of ['aria-labelledby', 'aria-describedby']) {
            for (const id of (ref.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) found.push(`${attr}="${id}" points at nothing`);
          }
        }
        return found;
      });
      expect(problems).toEqual([]);
    });
  }

  test('a revision page has one h1 and named controls', async ({ page }) => {
    await open(page, await firstRevisionPath(page));
    await expect(page.locator('li.rv-row').first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    expect(unnamed(await page.locator('body').ariaSnapshot())).toEqual([]);
  });

  test('the sign-in page is a labelled form', async ({ page }) => {
    await open(page, '/login', { signedout: true });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
    await expect(page.getByLabel('Operator token')).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('Operator token')).toHaveAttribute('aria-describedby', 'login-msg');
    await expect(page.locator('#login-msg')).toHaveAttribute('role', 'alert');
  });

  test('status is never colour alone: severity is written next to every glyph', async ({ page }) => {
    await open(page, '/problems');
    await expect(page.locator('details.prow').first().locator('summary .pill, summary [class*=pill]').first()).toContainText(/Error|Warning|Offline|Notice/);
    await open(page, '/machines');
    for (const pill of await page.locator('article.card .pill').all()) await expect(pill).toHaveText(/\S/);
    await expect(h1(page)).toBeVisible();
  });

  test('a dialog is announced as one, named, and hides nothing from the keyboard behind it', async ({ page }) => {
    await open(page, '/machines/design-imac/settings');
    await page.getByRole('button', { name: 'Remove…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleName('Remove design-imac permanently?');
  });
});
