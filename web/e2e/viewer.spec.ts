import { expect, test, type Page } from '@playwright/test';

// Fixture facts (internal/fixture/fixture.go)
const GENERAL = 'C0GENERAL';
const BASE = 1709564400;
const ts = (n: number) => `${BASE + n * 60}.${String(n).padStart(6, '0')}`;
const pTS = (n: number) => 'p' + ts(n).replace('.', '');

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
});
test.afterEach(() => {
  expect(errors, 'browser errors').toEqual([]);
});

async function openGeneral(page: Page) {
  await page.goto(`/client/${GENERAL}`);
  await expect(page.locator('.msg').last()).toBeVisible();
}

test('conversation opens at the most recent message and loads older on scroll', async ({ page }) => {
  await openGeneral(page);
  // newest top-level message is the thread broadcast (#250)
  await expect(page.locator('.msg').last()).toContainText('Replying in thread and channel');
  // thread replies are not in the channel timeline
  await expect(page.getByText('Reply 2: Friday deploys are risky')).toHaveCount(0);
  // scroll to the very top repeatedly until the channel intro appears
  for (let i = 0; i < 20; i++) {
    if (await page.locator('.channel-intro').isVisible()) break;
    await page.locator('.virtuoso').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(250);
  }
  await expect(page.locator('.channel-intro')).toContainText('very beginning');
  await expect(page.getByText('General message number 0 about the roadmap')).toBeVisible();
});

test('rendering: mentions, links, emoji, edits, reactions, files, bots, pins', async ({ page }) => {
  await page.goto(`/client/${GENERAL}/${ts(5)}`);
  const m5 = page.locator(`.msg[data-ts="${ts(5)}"]`);
  await expect(m5).toBeVisible();
  await expect(m5.locator('.mention')).toHaveText('@alice');
  await expect(m5.locator('a.link')).toHaveText('the docs');
  await expect(m5.locator('.emoji').first()).toHaveText('🎉');
  await expect(m5.locator('.msg-edited')).toBeVisible();
  await expect(m5.locator('.reaction')).toHaveCount(2);
  const m6 = page.locator(`.msg[data-ts="${ts(6)}"]`);
  await expect(m6.locator('.file-image img')).toBeVisible();
  await expect(page.locator(`.msg[data-ts="${ts(7)}"] .file-tombstone`)).toHaveText('This file was deleted.');
  await expect(page.locator(`.msg[data-ts="${ts(8)}"] .msg-pinned-label`)).toBeVisible();
  const bot = page.locator(`.msg[data-ts="${ts(9)}"]`);
  await expect(bot.locator('.msg-author')).toHaveText('Deploy Bot');
  await expect(bot.locator('.attachment')).toContainText('Deploy finished');
  await expect(bot.locator('.att-field')).toContainText('prod');
  // lightbox
  await m6.locator('.file-image').click();
  await expect(page.locator('.lightbox-img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.lightbox')).toHaveCount(0);
});

test('thread pane opens at the latest reply, with jump to beginning', async ({ page }) => {
  await page.goto(`/client/${GENERAL}/${ts(100)}`);
  const parent = page.locator(`.message-list .msg[data-ts="${ts(100)}"]`);
  await expect(parent.locator('.thread-count')).toHaveText('4 replies');
  await parent.locator('.thread-summary').click();
  const pane = page.locator('.thread-pane');
  await expect(pane.locator('.msg')).toHaveCount(5);
  await expect(pane.locator('.msg').last()).toContainText('Reply 3');
  await expect(page).toHaveURL(new RegExp(`/client/${GENERAL}/thread/${ts(100).replace('.', '\\.')}`));
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('Slack permalinks to a reply open the thread with the reply highlighted', async ({ page }) => {
  await page.goto(`/archives/${GENERAL}/${pTS(252)}?thread_ts=${ts(100)}&cid=${GENERAL}`);
  await expect(page.locator('.thread-pane')).toBeVisible();
  await expect(page.locator(`.thread-pane .msg[data-ts="${ts(252)}"]`)).toHaveClass(/highlighted/);
  // a permalink without thread_ts is resolved through the lookup API
  await page.goto(`/archives/${GENERAL}/${pTS(251)}`);
  await expect(page.locator(`.thread-pane .msg[data-ts="${ts(251)}"]`)).toBeVisible();
});

test('jump to the very beginning from the date divider', async ({ page }) => {
  await openGeneral(page);
  await page.locator('.floating-day .day-pill').click();
  await page.getByRole('button', { name: 'The very beginning' }).click();
  await expect(page.locator('.channel-intro')).toBeVisible();
  await expect(page.getByText('Jump to recent messages')).toBeVisible();
  await page.getByText('Jump to recent messages').click();
  await expect(page.locator('.msg').last()).toContainText('Replying in thread and channel');
});

test('search with modifiers, highlighting, and opening a result', async ({ page }) => {
  await openGeneral(page);
  await page.keyboard.press('ControlOrMeta+g');
  await page.keyboard.type('risky from:@alice');
  await page.keyboard.press('Escape'); // close suggestions
  await page.locator('.searchbox input').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=risky/);
  await expect(page.locator('.search-tab.active .tab-count')).toHaveText('2');
  await expect(page.locator('.search-result mark.hl').first()).toHaveText('risky');
  await page.locator('.search-result').first().click();
  await expect(page.locator('.thread-pane')).toBeVisible();
});

test('search autocomplete completes from: people', async ({ page }) => {
  await openGeneral(page);
  await page.keyboard.press('ControlOrMeta+g');
  await page.keyboard.type('from:car');
  await expect(page.locator('.sugg.sel')).toContainText('Carol');
  await page.keyboard.press('Enter');
  await expect(page.locator('.searchbox input')).toHaveValue('from:@carol ');
});

test('⌘F scopes search to the current conversation', async ({ page }) => {
  await openGeneral(page);
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('.searchbox input')).toHaveValue('in:#general ');
});

test('quick switcher (⌘K) and ⌥↑/⌥↓', async ({ page }) => {
  await openGeneral(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('.switcher')).toBeVisible();
  await page.keyboard.type('secret');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/G0PRIVATE/);
  await expect(page.locator('.channel-name')).toHaveText('secret-project');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page).toHaveURL(new RegExp(GENERAL));
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page).toHaveURL(/G0PRIVATE/);
  // switcher accepts pasted Slack links
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type(`https://example.slack.com/archives/${GENERAL}/${pTS(8)}`);
  await page.keyboard.press('Enter');
  await expect(page.locator(`.msg[data-ts="${ts(8)}"]`)).toHaveClass(/highlighted/);
});

test('navigation shortcuts: help, browse, people, details, sidebar, right pane, history', async ({ page }) => {
  await openGeneral(page);
  await page.keyboard.press('ControlOrMeta+/');
  await expect(page.getByRole('dialog')).toContainText('Keyboard shortcuts');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+l');
  await expect(page.getByRole('dialog')).toContainText('All channels');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect(page.getByRole('dialog')).toContainText('Bob Brown');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+k');
  await expect(page.getByRole('dialog')).toContainText('Direct messages');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+i');
  await expect(page.getByRole('dialog')).toContainText('Company-wide');
  await page.getByRole('button', { name: /^Pins/ }).click();
  await expect(page.getByRole('dialog')).toContainText('release checklist');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+d');
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+d');
  await expect(page.locator('.sidebar')).toBeVisible();
  // open a thread, then hide/show the right pane
  await page.goto(`/client/${GENERAL}/thread/${ts(100)}`);
  await expect(page.locator('.thread-pane')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+.');
  await expect(page.locator('.thread-pane')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+.');
  await expect(page.locator('.thread-pane')).toBeVisible();
  // history
  await page.goto(`/client/G0PRIVATE`);
  await expect(page.locator('.channel-name')).toHaveText('secret-project');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page).toHaveURL(/thread/);
  await page.keyboard.press('ControlOrMeta+]');
  await expect(page).toHaveURL(/G0PRIVATE/);
});

test('message keyboard navigation: arrows, Enter opens thread, F6 cycles focus', async ({ page }) => {
  await page.goto(`/client/${GENERAL}/${ts(101)}`);
  await expect(page.locator(`.msg[data-ts="${ts(101)}"]`)).toBeVisible();
  await page.locator('.message-list').focus();
  // ↑ from nothing focuses the newest loaded message; walk to the thread parent
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('ArrowUp');
    if ((await page.locator('.msg.focused').getAttribute('data-ts')) === ts(100)) break;
  }
  await expect(page.locator('.msg.focused')).toHaveAttribute('data-ts', ts(100));
  await page.keyboard.press('Enter');
  await expect(page.locator('.thread-pane')).toBeVisible();
  await page.keyboard.press('F6');
  await expect(page.locator('.thread-pane .pane-body')).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.locator('.sidebar-item.active')).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.locator('.message-list')).toBeFocused();
});

test('DMs, unknown users and alias suggestions', async ({ page }) => {
  await page.goto('/client/D0OLDBOB');
  // the fixture's first launch suggested OldBob → Bob (not applied until confirmed)
  await expect(page.locator('.channel-name')).toContainText('Unknown user');
  await page.goto('/unknown-users');
  const row = page.locator('.uu-row').filter({ hasText: 'U0OLDBOB' });
  await expect(row).toContainText('Bob Brown');
  await expect(row).toContainText('addressed as “Bob”');
  await row.getByRole('button', { name: 'Confirm' }).click();
  await expect(row.locator('.uu-status')).toHaveText('confirmed');
  await page.goto('/client/D0OLDBOB');
  await expect(page.locator('.channel-name')).toHaveText('Bob Brown');
  await expect(page.locator('.badge-old').first()).toBeVisible();
  // undo for other tests
  await page.goto('/unknown-users');
  await page.locator('.uu-row').filter({ hasText: 'U0OLDBOB' }).getByRole('button', { name: 'Reject' }).click();
});

test('dark mode renders without errors', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openGeneral(page);
  const bg = await page.locator('.main').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(26, 29, 33)');
});

test('gear menu: About and Aliases pages', async ({ page }) => {
  await page.goto('/client/C0GENERAL');
  await page.getByRole('button', { name: 'SlackDumpViewer menu' }).click();
  await page.getByRole('menuitem', { name: 'About this archive' }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.locator('.about-page h1')).toHaveText('About this archive');
  await expect(page.locator('.about-tile').first()).toContainText('messages');
  await expect(page.locator('.about-rows').first()).toContainText('Location');
  await expect(page.locator('.about-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.about-top li').first()).toContainText('general');
  await expect(page).toHaveTitle(/^About - .* — SlackDumpViewer$/);

  await page.getByRole('button', { name: 'SlackDumpViewer menu' }).click();
  await page.getByRole('menuitem', { name: 'Aliases' }).click();
  await expect(page).toHaveURL(/\/aliases$/);
  await expect(page.locator('.unknown-page h1')).toHaveText('Aliases');
  await expect(page.locator('.unknown-page .search-head')).toContainText('aliases.json');
  await expect(page.locator('.uu-row').filter({ hasText: 'U0OLDBOB' })).toBeVisible();
});
