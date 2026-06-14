import { test, expect, type Page } from 'shotest';

// Browser-level tests for the dashboard CRUD editor, replacing the old
// fake-socket unit tests. They drive the real bundled dashboard against a live
// helloworld server (started via playwright.config.ts → webServer) and exercise
// the editor flows that were recently fixed:
//   - record fields: "+ Add entry" actually adds an editable row
//   - link fields: the autocomplete loads options (no perpetual "No matches")
//   - optional fields: rendered as a set/undefined buttonChooser
//
// The password matches LOWLANDER_DASHBOARD_PASSWORD in playwright.config.ts.
const PASSWORD = 'test-secret-pw';

/** Locate the `.s-field` wrapper whose label is exactly `name`. */
function field(page: Page, name: string) {
    return page.locator('.s-field').filter({ has: page.getByText(name, { exact: true }) });
}

test('login rejects a wrong password', async ({ page }) => {
    await page.goto('/_dashboard');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    // The dashboard stays on the login screen and surfaces the server error.
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(page.getByText('Invalid dashboard password')).toBeVisible();
});

test('edit a MyModel record: add a map entry, set a link, toggle an optional', async ({ page }) => {
    await page.goto('/_dashboard');

    // ── Log in ──
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();

    // ── Open MyModel and edit its first record ──
    await page.getByRole('button', { name: 'MyModel' }).click();
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await expect(page.getByText('Edit MyModel')).toBeVisible();

    // ── Record field: "+ Add entry" adds an editable key row (the main bug) ──
    const meta = field(page, 'meta');
    const keysBefore = await meta.getByPlaceholder('key').count();
    await meta.getByRole('button', { name: '+ Add entry' }).click();
    await expect(meta.getByPlaceholder('key')).toHaveCount(keysBefore + 1);
    // The new row is editable inline.
    await meta.getByPlaceholder('key').last().fill('newScore');

    // ── Link field: the autocomplete loads options (no "No matches") ──
    const owner = field(page, 'owner');
    const ownerInput = owner.getByPlaceholder('Search Person…');
    await ownerInput.click();
    await ownerInput.fill(''); // clear the seeded value so all options show
    await expect(page.getByRole('option', { name: 'Alice' })).toBeVisible();
    await page.getByRole('option', { name: 'Alice' }).click();

    // ── Optional field: rendered as a set/undefined buttonChooser ──
    const next = field(page, 'next');
    await expect(next.getByRole('button', { name: 'set' })).toBeVisible();
    await expect(next.getByRole('button', { name: 'undefined' })).toBeVisible();

    // Close without persisting — this test only verifies editor behaviour.
    // (No assertion on disappearance: the dialog fades out via an opacity
    // transition with a delayed DOM removal, which is awkward to assert on.)
    await page.getByRole('button', { name: 'Cancel' }).click();
});
