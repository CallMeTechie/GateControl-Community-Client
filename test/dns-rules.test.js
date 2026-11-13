'use strict';

// „Namen im VPN“: the server answers device names in several zones
// (internalDns.domains). main.js keeps one DNS rule per zone (client-core
// DnsPolicy.rulesFor / sync): on connect, after every config check, none
// after disconnect.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const from = (needle, length) => {
  const at = MAIN_JS.indexOf(needle);
  assert.ok(at >= 0, 'missing in main.js: ' + needle);
  return MAIN_JS.slice(at, at + length);
};

describe('main.js DNS rules for device names', () => {
  it('one rule per zone of the server, only while the tunnel is up', () => {
    const sync = from('async function syncPeerDnsRules(', 500);
    assert.match(sync, /DnsPolicy\.rulesFor\(\{\s*internalDns: store\.get\('tunnel\.internalDns'\),/);
    assert.match(sync, /if \(!tunnelState\.connected\) return;\s*await dnsPolicy\.sync\(rules, \{ force \}\);/);
  });

  it('on connect the rules are set anew', () => {
    assert.match(MAIN_JS, /syncPeerDnsRules\(\{ force: true \}\)\.catch/);
  });

  it('every config check brings the rules in step, also without a new config', () => {
    const check = from('function checkConfigNow()', 900);
    assert.match(check, /if \(apiClient\.internalDns !== undefined\) rememberInternalDns\(\);\s*if \(!newConfig\) \{\s*if \(dnsPolicy && tunnelState\.connected\) await syncPeerDnsRules\(\);\s*return;/);
  });

  it('disconnect removes all own rules before the tunnel goes down', () => {
    const down = from('async function disconnectTunnel()', 700);
    assert.match(down, /await dnsPolicy\.removeAll\(\);/);
    assert.ok(down.indexOf('dnsPolicy.removeAll()') < down.indexOf('wgService.disconnect()'));
  });

  it('no single fixed rule any more, no zone in the program', () => {
    assert.ok(!/DnsPolicy\.ruleFor\(|dnsPolicy\.add\(/.test(MAIN_JS));
    assert.ok(!/gc\.internal/.test(MAIN_JS));
  });
});
