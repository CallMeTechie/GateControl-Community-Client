'use strict';

// "Mit Windows starten": the switch goes through the Community override of
// autostart:set (Task Scheduler task, src/main/autostart.js; in e2e mode the
// system is left alone) and shows the stored state, also after a restart of
// the page.

const { test, expect } = require('./support/fixtures');
const { openSettingsTab } = require('./support/ui');

test.describe('autostart switch', () => {
  test('off and on: stored, shown again after reload', async ({ launchApp }) => {
    const { page } = await launchApp();
    const stored = () => page.evaluate(() => window.gatecontrol.config.get('app.startWithWindows'));

    await openSettingsTab(page, 'app');
    const sw = page.locator('#opt-autostart');
    await expect(sw).toBeChecked();

    await sw.locator('xpath=..').click();
    await expect(sw).not.toBeChecked();
    await expect.poll(stored).toBe(false);

    await page.reload();
    await openSettingsTab(page, 'app');
    await expect(page.locator('#opt-autostart')).not.toBeChecked();

    await page.locator('#opt-autostart').locator('xpath=..').click();
    await expect(page.locator('#opt-autostart')).toBeChecked();
    await expect.poll(stored).toBe(true);
  });
});
