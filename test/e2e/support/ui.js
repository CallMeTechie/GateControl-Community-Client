'use strict';

// UI steps of the Community client shared by the specs (selectors by id, so
// the tests do not depend on the UI language).
const { expect } = require('@playwright/test');

async function openSettingsTab(page, tab) {
  await page.locator('.nav-btn[data-page="settings"]').click();
  await expect(page.locator('#page-settings')).toHaveClass(/active/);
  await page.locator(`.set-tab[data-tab="${tab}"]`).click();
  await expect(page.locator(`#set-${tab}`)).toHaveClass(/active/);
}

/** Settings → Connection: server URL + API key, "Save & register". */
async function setupWithApiKey(page, mock) {
  await openSettingsTab(page, 'conn');
  await page.locator('#server-url').fill(mock.url);
  await page.locator('#api-key').fill(mock.token);
  await page.locator('#btn-save-server').click();
  await expect(page.locator('#server-status')).toHaveClass(/success/);
}

/** Settings → About → "Check for updates". */
async function checkForUpdatesManually(page) {
  await openSettingsTab(page, 'about');
  await page.locator('#btn-check-update').click();
  await expect(page.locator('#btn-check-update')).toBeEnabled();
}

const updateBanner = (page) => page.locator('#update-banner');
const updateInstallButton = (page) => page.locator('#update-banner .update-card-actions button').first();

module.exports = { setupWithApiKey, openSettingsTab, checkForUpdatesManually, updateBanner, updateInstallButton };
