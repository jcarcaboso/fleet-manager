import { expect, type Locator, type Page } from '@playwright/test';
import { appUrl, type Switches } from './mock';

/** The mock's signed-in account; its seeded password check accepts any password that does not start with `bad`. */
export const ACCOUNT = 'joan';
export const GOOD_PASSWORD = 'e2e-operator-password';
/** A password the mock rejects. */
export const BAD_PASSWORD = 'bad-password';

export const h1 = (page: Page): Locator => page.getByRole('heading', { level: 1 });
export const primaryNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Primary' });
/** The machine cards of the gallery, by alias. */
export const card = (page: Page, alias: string): Locator => page.locator('article.card').filter({ has: page.getByRole('heading', { level: 3, name: alias, exact: true }) });
export const cardAliases = (page: Page): Promise<string[]> => page.locator('article.card h3').allInnerTexts();

/** Opens a page of the app (the mock bundle) and waits until it shows its heading. */
export async function open(page: Page, path: string, switches: Switches = {}): Promise<void> {
  await page.goto(appUrl(path, switches));
  await expect(h1(page)).toBeVisible();
}

/** Opens a machine from the Machines gallery, as a user does. */
export async function openMachine(page: Page, alias: string, switches: Switches = {}): Promise<void> {
  await open(page, '/machines', switches);
  await page.getByRole('link', { name: alias, exact: true }).click();
  await expect(h1(page)).toHaveText(alias);
}

export async function signIn(page: Page, password = GOOD_PASSWORD, name = ACCOUNT): Promise<void> {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Every page keeps the document inside the viewport width (no horizontal scrolling). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(widths.document, `document is wider than the ${widths.viewport}px viewport`).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body, `body is wider than the ${widths.viewport}px viewport`).toBeLessThanOrEqual(widths.viewport);
}

/** The text of the element that has keyboard focus: its accessible label, or its text. */
export function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return '<body>';
    return `${el.tagName.toLowerCase()}: ${el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}`;
  });
}

/**
 * The address of the page, ignoring the mock switches that stay in the query (`?scope=read`). `query` names parameters that must
 * have these values (a string or a pattern), for example the `redirect` of the sign-in page; it carries the mock switches too.
 */
export function atPath(path: string, query: Record<string, string | RegExp> = {}): (url: URL) => boolean {
  const matches = (actual: string | null, wanted: string | RegExp): boolean => (wanted instanceof RegExp ? wanted.test(actual ?? '') : actual === wanted);
  return url => url.pathname === path && Object.entries(query).every(([name, wanted]) => matches(url.searchParams.get(name), wanted));
}
