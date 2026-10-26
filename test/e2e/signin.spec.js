'use strict';

// "Mit Firmenkonto anmelden" in Settings → Connection (core signin:*,
// GateControl ≥ 1.201.0): the card appears only when the server in
// "Server-URL" offers it; password (+ 2FA) and Microsoft (browser + loopback +
// handoff with PKCE) both end with a setup code that the app redeems at
// /api/v1/client/enroll like a typed code.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, expect } = require('./support/fixtures');
const { openSettingsTab } = require('./support/ui');

const SECRET = 'Sommer-2026!';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function enrollCodes(mock) {
  return mock.requests.filter((r) => r.path === '/api/v1/client/enroll').map((r) => JSON.parse(r.raw.toString('utf8')).code);
}

/**
 * None of the files the app writes itself (its logs, the e2e events, the
 * stores in userData, its console output) contains the secrets. Chromium's
 * own profile files stay out: Windows keeps them locked while the app runs.
 */
function assertNotWritten(dir, secrets) {
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(path.join(dir, 'logs'));
  walk(path.join(dir, 'userData', 'logs')); // electron-log (main.log)
  for (const name of ['events.jsonl', 'main-process.log']) {
    if (fs.existsSync(path.join(dir, name))) files.push(path.join(dir, name));
  }
  const userData = path.join(dir, 'userData');
  if (fs.existsSync(userData)) {
    for (const e of fs.readdirSync(userData, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(userData, e.name));
    }
  }
  expect(files.some((f) => f.endsWith('.log') && fs.readFileSync(f, 'utf8').includes('Company sign-in')), 'the app log was checked').toBe(true);
  for (const file of files) {
    const text = fs.readFileSync(file).toString('latin1');
    for (const s of secrets) expect(text.includes(s), `${s} in ${file}`).toBe(false);
  }
}

async function typeServer(page, mock) {
  await openSettingsTab(page, 'conn');
  await page.locator('#server-url').fill(mock.url);
}

test.describe('company sign-in', () => {
  test('older server (404): no sign-in card', async ({ launchApp, mock }) => {
    const { page } = await launchApp();
    await typeServer(page, mock);
    await expect.poll(() => mock.count('/api/v1/client/signin')).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);
    await expect(page.locator('#signin-card')).toBeHidden();
  });

  test('password with 2FA sets the device up through the setup-code path', async ({ launchApp, mock }) => {
    const signin = mock.setSignin({ totp: '246810' });
    const { page, dir } = await launchApp();
    await typeServer(page, mock);

    await expect(page.locator('#signin-card')).toBeVisible();
    await expect(page.locator('#signin-hint')).toHaveText('Firmenkonto (corp.local): mit dem Windows-Passwort anmelden');
    await expect(page.locator('#signin-ms .btn')).toHaveCount(1);
    await expect(page.locator('#signin-ms .btn')).toContainText('Contoso');

    await page.locator('#signin-user').fill('anna@corp.local');
    await page.locator('#signin-pass').fill('falsch');
    await page.locator('#btn-signin').click();
    await expect(page.locator('#signin-status')).toHaveClass(/error/);

    await page.locator('#signin-pass').fill(SECRET);
    await page.locator('#btn-signin').click();
    await expect(page.locator('#signin-totp-field')).toBeVisible();
    await expect(page.locator('#btn-signin')).toBeDisabled();
    await page.locator('#signin-totp').fill('246810');
    await page.locator('#signin-totp').press('Enter');

    await expect(page.locator('#signin-status')).toHaveClass(/success/);
    expect(signin.issued).toHaveLength(1);
    expect(enrollCodes(mock)).toEqual(signin.issued);
    expect(signin.attempts.map((a) => a.totp)).toEqual([null, null, '246810']);
    expect(await page.locator('#signin-pass').inputValue()).toBe('');
    // The same as after "Save & register": token stored for the server.
    expect(mock.count('/api/v1/client/register')).toBe(0);
    assertNotWritten(dir, [SECRET, '246810', signin.issued[0]]);
  });

  test('Mit Microsoft anmelden: default browser, loopback answer, handoff', async ({ launchApp, mock }) => {
    const signin = mock.setSignin({ password: { enabled: false, hint: null }, microsoft: [{ id: 7, label: 'Contoso' }, { id: 9, label: 'Fabrikam' }] });
    const { page, events, dir } = await launchApp();
    await typeServer(page, mock);
    await expect(page.locator('#signin-card')).toBeVisible();
    await expect(page.locator('#signin-user-field')).toBeHidden();
    await expect(page.locator('#btn-signin')).toBeHidden();
    await expect(page.locator('#signin-ms .btn')).toHaveCount(2);

    await page.locator('#signin-ms .btn').nth(1).click();
    await expect(page.locator('#btn-signin-cancel')).toBeVisible();
    const opened = () => events().filter((e) => e.type === 'shell.openExternal').map((e) => e.url);
    await expect.poll(() => opened().length).toBe(1);
    const start = new URL(opened()[0]);
    expect(`${start.origin}${start.pathname}`).toBe(`${mock.url}/auth/oidc/9/start`);
    const q = Object.fromEntries(start.searchParams);
    expect(q.client).toBe('app');
    expect(q.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/signin$/);

    const handoff = signin.issueHandoff(q.challenge);
    const back = new URL(q.redirect_uri);
    back.searchParams.set('handoff', handoff);
    back.searchParams.set('state', q.state);
    const res = await get(back.toString());
    expect(res.status).toBe(200);
    expect(res.body).toContain('Anmeldung abgeschlossen – du kannst dieses Fenster schließen.');

    await expect(page.locator('#signin-status')).toHaveClass(/success/);
    expect(enrollCodes(mock)).toEqual(signin.issued);
    await expect(get(back.toString())).rejects.toThrow();
    assertNotWritten(dir, [handoff, signin.issued[0]]);
  });

  test('Microsoft: a foreign state is refused, cancel ends the wait', async ({ launchApp, mock }) => {
    mock.setSignin();
    const { page, events } = await launchApp();
    await typeServer(page, mock);
    await expect(page.locator('#signin-card')).toBeVisible();

    const opened = () => events().filter((e) => e.type === 'shell.openExternal').map((e) => e.url);
    await page.locator('#signin-ms .btn').first().click();
    await expect.poll(() => opened().length).toBe(1);
    const q = Object.fromEntries(new URL(opened()[0]).searchParams);
    expect((await get(`${q.redirect_uri}?handoff=abc&state=not-the-state`)).status).toBe(400);
    await expect(page.locator('#signin-status')).toHaveClass(/error/);
    expect(mock.count('/api/v1/client/signin/handoff')).toBe(0);

    await page.locator('#signin-ms .btn').first().click();
    await expect.poll(() => opened().length).toBe(2);
    await page.locator('#btn-signin-cancel').click();
    await expect(page.locator('#btn-signin-cancel')).toBeHidden();
    await expect(page.locator('#signin-status')).toBeHidden();
    const q2 = Object.fromEntries(new URL(opened()[1]).searchParams);
    await expect(get(`${q2.redirect_uri}?handoff=abc&state=${q2.state}`)).rejects.toThrow();
  });
});
