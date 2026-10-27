import { test, expect } from '../support/fixtures';
import { card, cardAliases, h1, open } from '../support/app';
import { mockCalls } from '../support/mock';

const search = (page: import('@playwright/test').Page) => page.getByRole('searchbox', { name: 'Search machines' });
const groupButton = (page: import('@playwright/test').Page, name: string) => page.getByRole('group', { name: 'Group by' }).getByRole('button', { name, exact: true });
const sections = (page: import('@playwright/test').Page) => page.locator('#gallery-body section.gsec h2');

test.describe('Machines gallery', () => {
  test('shows every machine as a card with its health, OS and Agent', async ({ page }) => {
    await open(page, '/machines');
    await expect(h1(page)).toHaveText(/\d+ of 13 machines are up to date/);
    await expect(page.locator('article.card')).toHaveCount(14); // 13 live machines and one revoked
    await expect(card(page, 'design-imac')).toContainText('Action needed');
    await expect(card(page, 'design-imac')).toContainText('macOS 15.1 · aarch64');
    await expect(card(page, 'design-imac')).toContainText('Agent 0.9.0');
    await expect(card(page, 'homelab-nuc')).toContainText('Fedora Linux 44');
    await expect(card(page, 'build-runner-03')).toContainText('Offline');
    await expect(card(page, 'fedora-ws')).toContainText('Update available');
    // Revoked machines are kept apart, collapsed.
    const retired = page.locator('details.retired');
    await expect(retired).toContainText('Retired');
    await expect(retired).not.toHaveAttribute('open', '');
    await expect(page.getByRole('link', { name: 'old-laptop' })).toBeHidden();
    await retired.locator('summary').click();
    await expect(card(page, 'old-laptop')).toBeVisible();
    await expect(card(page, 'old-laptop')).toContainText('Revoked');
  });

  test('searches by name, OS, Agent version and status, and clears the search', async ({ page }) => {
    await open(page, '/machines');
    await search(page).fill('fedora');
    await expect.poll(() => cardAliases(page)).toEqual(['fedora-ws', 'homelab-nuc']);

    await search(page).fill('0.9.0-rc.2');
    await expect.poll(() => cardAliases(page)).toEqual(['fedora-ws']);

    await search(page).fill('offline');
    await expect.poll(() => cardAliases(page)).toEqual(['build-runner-03', 'mba-travel']);

    await search(page).fill('linux ubuntu');
    await expect.poll(async () => (await cardAliases(page)).sort()).toEqual(['build-runner-01', 'build-runner-02', 'build-runner-03']);

    await search(page).fill('no-such-machine');
    await expect(page.getByRole('heading', { name: /No machines match “no-such-machine”/ })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search(page)).toHaveValue('');
    await expect(search(page)).toBeFocused();
    await expect(page.locator('article.card')).toHaveCount(14);
  });

  test('groups by status, platform and OS', async ({ page }) => {
    await open(page, '/machines');
    await expect(groupButton(page, 'Status')).toHaveAttribute('aria-pressed', 'true');
    await expect(sections(page)).toHaveText([/Needs attention\s*9/, /Updating\s*2/, /Up to date\s*2/]);

    await groupButton(page, 'Platform').click();
    await expect(groupButton(page, 'Platform')).toHaveAttribute('aria-pressed', 'true');
    await expect(groupButton(page, 'Status')).toHaveAttribute('aria-pressed', 'false');
    await expect(sections(page)).toHaveText([/macOS\s*6/, /Linux\s*7/]);
    await expect(page.locator('#sec-linux article.card')).toHaveCount(7);
    await expect(page.locator('#sec-linux').getByRole('link', { name: 'gpu-box' })).toBeVisible();

    await groupButton(page, 'OS').click();
    await expect(sections(page).filter({ hasText: 'Fedora Linux' })).toHaveCount(1);
    await expect(sections(page).filter({ hasText: 'Ubuntu' })).toHaveCount(1);
    await expect(sections(page).filter({ hasText: 'macOS' })).toHaveCount(1);
    await expect(page.locator('article.card')).toHaveCount(14);
  });

  test('sorts by name, fullest disk and last seen', async ({ page }) => {
    await open(page, '/machines');
    await groupButton(page, 'Platform').click();
    const sort = page.getByLabel('Sort');
    const linux = () => page.locator('#sec-linux article.card h3').allInnerTexts();

    await sort.selectOption('name');
    await expect.poll(linux).toEqual(['build-runner-01', 'build-runner-02', 'build-runner-03', 'fedora-ws', 'gpu-box', 'homelab-nuc', 'lab-vm-07']);

    await sort.selectOption('disk');
    await expect.poll(async () => (await linux())[0]).toBe('homelab-nuc'); // 96.4% used
    const used = await page.locator('#sec-linux article.card').evaluateAll(cards => cards.map(el => Number(/Disk ([\d.]+)% used/.exec(el.querySelector('.diskm-k')?.textContent ?? '')?.[1] ?? -1)));
    expect(used).toEqual([...used].sort((a, b) => b - a));
    expect(used.at(-1)).toBe(-1); // lab-vm-07 has not reported a disk

    await sort.selectOption('seen');
    await expect.poll(async () => (await linux()).at(-1)).toBe('lab-vm-07'); // never seen
  });

  test('draws a disk meter on each card, with a state that is also written out', async ({ page }) => {
    await open(page, '/machines');
    const meter = (alias: string) => card(page, alias).getByRole('img', { name: /^Disk / });
    await expect(meter('homelab-nuc')).toHaveAttribute('aria-label', 'Disk 96.4% used, Nearly full');
    await expect(card(page, 'homelab-nuc').locator('.diskm-state')).toHaveText('Nearly full');
    await expect(meter('gpu-box')).toHaveAttribute('aria-label', /^Disk 85\.0% used, Filling up$/);
    await expect(meter('design-imac')).toHaveAttribute('aria-label', 'Disk 83.9% used, Enough space');
    await expect(card(page, 'design-imac')).toContainText('290.9 GiB free of 1.8 TiB');
    await expect(card(page, 'kitchen-mini')).toContainText('No disk data'); // Agent 0.6.6 does not report disks
    await expect(meter('kitchen-mini')).toHaveCount(0);
    // The meter's width is the used share.
    await expect(meter('homelab-nuc').locator('span')).toHaveCSS('width', /\d/);
    const widths = await meter('homelab-nuc').evaluate(el => ({ bar: (el.firstElementChild as HTMLElement).getBoundingClientRect().width, track: el.getBoundingClientRect().width }));
    expect(widths.bar / widths.track).toBeCloseTo(0.964, 2);
  });

  test('loads check-in strips only for the cards near the screen, and the rest when scrolled to', async ({ page }) => {
    await open(page, '/machines');
    const requested = async () => (await mockCalls(page)).filter(call => /^nodes\/[^/]+\/checkins$/.test(call.path) && !call.aborted);
    // The first row of cards starts below the 720 px fold plus the observer's margin: nothing has been asked for yet.
    await expect(page.locator('.strip-pending')).toHaveCount(13);
    expect(await requested()).toHaveLength(0);

    await page.locator('article.card').first().scrollIntoViewIfNeeded();
    await expect(page.locator('.strip-slot svg').first()).toBeVisible();
    const near = await requested();
    expect(near.length).toBeGreaterThan(0);
    expect(near.length, 'cards further down should not have asked yet').toBeLessThan(13);
    expect(near.every(call => call.query.hours === '24')).toBe(true);

    // Scrolling the page down card by card brings every other strip into range, one request per machine.
    await page.locator('footer.foot').scrollIntoViewIfNeeded();
    expect(new Set((await requested()).map(call => call.path)).size, 'the bottom of the page is not the middle of it').toBeLessThan(13);
    const live = page.locator('section.gsec article.card');
    for (let i = 0; i < (await live.count()); i += 1) await live.nth(i).scrollIntoViewIfNeeded();
    await expect.poll(async () => new Set((await requested()).map(call => call.path)).size).toBe(13); // the revoked machine never asks
    await expect(card(page, 'laptop-ana').locator('.strip-slot svg')).toBeVisible();
    await expect(page.locator('.strip-pending')).toHaveCount(0);
  });
});
