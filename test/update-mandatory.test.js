'use strict';

// Server-controlled updates in the Community client: channel display
// (read-only, assigned by the server) and the non-dismissable
// "Update erforderlich" notice for mandatory updates. Decision logic in
// src/renderer/update-state.js (no DOM), wiring checked statically.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { updateCardState, channelLabelKey, installErrorText } = require('../src/renderer/update-state');

describe('updateCardState', () => {
  it('hidden without a ready update', () => {
    assert.equal(updateCardState(null, { mandatory: true }, false).visible, false);
  });

  it('optional update can be dismissed', () => {
    const s = updateCardState({ version: '1.30.0' }, { mandatory: false, minVersion: null }, false);
    assert.deepEqual(s, { visible: true, mandatory: false, dismissable: true, version: '1.30.0', minVersion: null });
    assert.equal(updateCardState({ version: '1.30.0' }, null, true).visible, false);
  });

  it('mandatory update stays visible even after "later" and is not dismissable', () => {
    const s = updateCardState({ version: '1.30.0' }, { mandatory: true, minVersion: '1.29.0' }, true);
    assert.deepEqual(s, { visible: true, mandatory: true, dismissable: false, version: '1.30.0', minVersion: '1.29.0' });
  });

  it('the newest policy wins over the flag of the ready event', () => {
    assert.equal(updateCardState({ version: '1.30.0', mandatory: true }, { mandatory: false }, false).mandatory, false);
    assert.equal(updateCardState({ version: '1.30.0', mandatory: true }, null, false).mandatory, true);
  });

  it('channel labels', () => {
    assert.equal(channelLabelKey('beta'), 'update.channelBeta');
    assert.equal(channelLabelKey('stable'), 'update.channelStable');
    assert.equal(channelLabelKey(undefined), 'update.channelUnknown');
  });
});

describe('wiring', () => {
  const html = read('src/renderer/index.html');
  const renderer = read('src/renderer/renderer.js');
  const main = read('src/main/main.js');

  it('loads the helper before renderer.js (CSP: self only)', () => {
    assert.ok(html.includes('<script src="update-state.js"></script>'));
    assert.ok(html.indexOf('update-state.js') < html.indexOf('renderer.js'));
  });

  it('mandatory: notice slot on the overview, no "later"/close for it', () => {
    assert.match(html, /<div id="update-required-slot"><\/div>/);
    const fn = /function renderUpdateCard\(\) \{[\s\S]*?\n\}/.exec(renderer)[0];
    assert.match(fn, /if \(st\.dismissable\) \{/);
    // the notice itself only gets an install button
    const notice = fn.slice(fn.indexOf("notice.id = 'update-required-banner'"));
    assert.match(notice, /installUpdateNow\(\)/);
    assert.doesNotMatch(notice, /\.remove\(\)\);/);
  });

  it('a failed install shows its reason in the card (no silent nothing)', () => {
    const fn = renderer.match(/async function installUpdateNow\(\) \{([\s\S]*?)\n\}/);
    assert.ok(fn, 'installUpdateNow');
    assert.match(fn[1], /await update\.install\(\)/);
    assert.match(fn[1], /installErrorText\(result, t\)/);
    const card = /function renderUpdateCard\(\) \{[\s\S]*?\n\}/.exec(renderer)[0];
    assert.match(card, /updateStatusText\(/);
    assert.match(card, /installBtn\.addEventListener\('click', \(\) => installUpdateNow\(\)\)/);
    assert.doesNotMatch(card, /update\.install\(\)/);
    const t = (k) => k;
    assert.equal(installErrorText({ ok: true }, t), null);
    assert.equal(installErrorText({ ok: false, code: 'exited', message: 'Exit-Code 2', vpnRestored: true }, t),
      'update.installFailed: update.installError.exited (Exit-Code 2) update.installVpnRestored');
  });

  it('main: the tray entry reports a failed install as a notification', () => {
    assert.match(main, /install: \(\) => installUpdateFromTray\(\)/);
    const fn = main.match(/function installUpdateFromTray\(\) \{([\s\S]*?)\n\}/);
    assert.ok(fn);
    assert.match(fn[1], /installErrorText\(result, t\)/);
    assert.match(fn[1], /showNotification\(/);
  });

  it('shows the channel read-only in Settings → About', () => {
    assert.match(html, /<span class="chip" id="update-channel">/);
    assert.match(renderer, /update\.onPolicy\(/);
  });

  it('main: product for the server, mandatory tray entry, no silent install', () => {
    assert.match(main, /clientType: 'community' \}/);
    assert.match(main, /updateMenuItems\(\{/);
    assert.match(main, /mandatory: !!updater\?\.isMandatory\(\)/);
    assert.match(main, /onPolicyChange:/);
    assert.ok(!/release\.mandatory[^\n]*installUpdate\(\)/.test(main));
  });

  it('i18n keys used by the notice exist in core (de/en)', () => {
    const core = path.dirname(require.resolve('@gatecontrol/client-core/package.json'));
    for (const lang of ['de', 'en']) {
      const loc = JSON.parse(fs.readFileSync(path.join(core, 'src', 'i18n', 'locales', `${lang}.json`), 'utf8'));
      for (const k of ['required', 'requiredDesc', 'requiredDescNoMin', 'requiredTunnelHint', 'channel', 'channelHint',
        'channelStable', 'channelBeta', 'channelUnknown', 'installRequired', 'install', 'later', 'installStarting', 'installFailed', 'installVpnRestored']) {
        assert.equal(typeof loc.update[k], 'string', `${lang}: update.${k}`);
      }
    }
  });
});
