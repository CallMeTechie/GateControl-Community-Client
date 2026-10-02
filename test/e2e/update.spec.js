'use strict';

const path = require('path');
const { test, expect, OFFERED_VERSION } = require('./support/fixtures');
const { setupWithApiKey, checkForUpdatesManually, updateBanner, updateInstallButton } = require('./support/ui');

const DOWNLOAD = (offer) => `/download/${offer.fileName}`;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSION_RE = new RegExp(escapeRegExp(OFFERED_VERSION));

/** Waits for the app to exit (installUpdate quits ~1.5 s after the launch). */
async function expectQuit(exited) {
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
  expect(code, 'app should quit after starting the installer').not.toBe('timeout');
}

function expectInstallerLaunched(events, offer) {
  const launches = events.filter((e) => e.type === 'shell.openPath');
  expect(launches).toHaveLength(1);
  const [launch] = launches;
  expect(path.basename(launch.path)).toBe(offer.fileName);
  expect(launch.sha256).toBe(offer.sha256);
  const quitIdx = events.findIndex((e) => e.type === 'app.before-quit');
  expect(quitIdx, 'quit after the installer launch').toBeGreaterThan(events.indexOf(launch));
}

test.describe('signed auto-update', () => {
  test('scheduled check → banner → "Install" starts the verified installer and quits', async ({ launchApp, mock, offerUpdate }) => {
    const offer = offerUpdate('valid');
    const { page, exited, events, runScheduledUpdateCheck } = await launchApp();
    await setupWithApiKey(page, mock);

    await runScheduledUpdateCheck();
    await expect(updateBanner(page)).toBeVisible();
    await expect(updateBanner(page)).toContainText(VERSION_RE);
    expect(mock.count(DOWNLOAD(offer))).toBe(1);

    await updateInstallButton(page).click();
    await expectQuit(exited);
    expectInstallerLaunched(events(), offer);
  });

  test('scheduled check → tray entry → tray "install" starts the installer and quits', async ({ launchApp, mock, offerUpdate }) => {
    const offer = offerUpdate('valid');
    const { page, exited, events, runScheduledUpdateCheck, trayLabels, clickTrayItem } = await launchApp();
    await setupWithApiKey(page, mock);
    expect((await trayLabels()).some((l) => VERSION_RE.test(l))).toBe(false);

    await runScheduledUpdateCheck();
    await expect.poll(async () => (await trayLabels()).some((l) => VERSION_RE.test(l))).toBe(true);

    // Tray menus cannot be opened by Playwright; the recorded menu item's
    // click handler is the one the tray would run.
    expect(await clickTrayItem(escapeRegExp(OFFERED_VERSION))).toBe(true);
    await expectQuit(exited);
    expectInstallerLaunched(events(), offer);
  });

  test('manual check reports the downloaded update and its banner installs it', async ({ launchApp, mock, offerUpdate }) => {
    const offer = offerUpdate('valid');
    const { page, exited, events, runScheduledUpdateCheck } = await launchApp();
    await setupWithApiKey(page, mock);

    await runScheduledUpdateCheck();
    await expect(updateBanner(page)).toBeVisible();
    await page.locator('#update-banner .update-card-actions button').last().click(); // "later"
    await expect(updateBanner(page)).toBeHidden();

    await checkForUpdatesManually(page);
    await expect(page.locator('#update-check-result')).toContainText(VERSION_RE);
    await expect(updateBanner(page)).toBeVisible();

    await updateInstallButton(page).click();
    await expectQuit(exited);
    expectInstallerLaunched(events(), offer);
  });

  for (const mode of ['tampered-manifest', 'wrong-key', 'bad-download']) {
    test(`rejects an update with ${mode}: no banner, no install`, async ({ launchApp, mock, offerUpdate }) => {
      const offer = offerUpdate(mode);
      const { app, page, events, runScheduledUpdateCheck, trayLabels } = await launchApp();
      await setupWithApiKey(page, mock);

      await runScheduledUpdateCheck();
      expect(mock.count('/api/v1/client/update/check')).toBeGreaterThanOrEqual(1);
      // Signature/manifest problems are rejected before any download.
      expect(mock.count(DOWNLOAD(offer))).toBe(mode === 'bad-download' ? 1 : 0);

      await checkForUpdatesManually(page);
      await expect(page.locator('#update-check-result')).not.toBeEmpty();
      await expect(page.locator('#update-check-result')).not.toContainText(VERSION_RE);
      await expect(updateBanner(page)).toHaveCount(0);
      expect((await trayLabels()).some((l) => VERSION_RE.test(l))).toBe(false);

      // Even a direct install request (as from a stale banner) does nothing.
      expect(await page.evaluate(() => window.gatecontrol.update.install())).toBe(false);
      await page.waitForTimeout(2000);
      expect(events().filter((e) => e.type === 'shell.openPath')).toHaveLength(0);
      expect(events().some((e) => e.type === 'app.before-quit')).toBe(false);
      expect(app.process().exitCode).toBeNull();
    });
  }
});
