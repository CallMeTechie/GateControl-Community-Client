'use strict';

// "App-Update aus dem Heimnetz" in der Community-App: Der Updater kommt aus
// dem Core und wird in main.js ohne eigene Netz-Optionen gebaut. Hält ein
// Home-Gateway im selben LAN den Installer vor, lädt der Updater ihn von dort
// (Zertifikats-Pin, Größe und SHA-256 des signierten Manifests); bei jedem
// Fehler vom normalen downloadUrl.
//
// Needs @gatecontrol/client-core (node_modules, .core or a sibling checkout).

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Readable } = require('node:stream');

const ROOT = path.join(__dirname, '..');
const PRODUCT = 'community';
const FILE = 'GateControl.Community.Client.Setup.9.9.9.exe';

function findCore() {
  try {
    return path.dirname(require.resolve('@gatecontrol/client-core/package.json', { paths: [ROOT] }));
  } catch { /* not installed */ }
  for (const dir of [path.join(ROOT, '.core'), path.join(ROOT, '..', 'gatecontrol-client-core')]) {
    if (fs.existsSync(path.join(dir, 'src', 'services', 'updater.js'))) return dir;
  }
  return null;
}

const coreDir = findCore();
let Updater = null;
let axios = null;
let selfsigned = null;
if (coreDir) {
  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return path.join(__dirname, 'fixtures', 'electron-stub.js');
    return realResolve.call(this, request, ...rest);
  };
  try {
    Updater = require(path.join(coreDir, 'src', 'services', 'updater.js'));
    axios = require(require.resolve('axios', { paths: [coreDir] }));
    selfsigned = require('selfsigned');
  } catch { Updater = null; } finally {
    Module._resolveFilename = realResolve;
  }
}
const skip = Updater && axios && selfsigned ? false : 'gatecontrol-client-core (with dependencies) not available';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const IFACES = {
  WLAN: [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
};

describe('update from the home network (core Updater, product community)', { skip }, () => {
  const cleanup = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) { try { await fn(); } catch { /* ignore */ } }
  });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const PUB = publicKey.export({ type: 'spki', format: 'pem' });
  const INSTALLER = Buffer.from('MZ community installer '.repeat(2000));
  const H = sha(INSTALLER);
  const manifest = JSON.stringify({ schema: 1, product: PRODUCT, version: '9.9.9', fileName: FILE, sha256: H, size: INSTALLER.length });
  const signature = crypto.sign(null, Buffer.from(manifest), privateKey).toString('base64');

  // The gateway's LAN endpoint: self-signed certificate without a name the
  // client knows, GET /blob/<sha256>?exp&sig → the installer.
  async function gateway(body = INSTALLER) {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'gateway' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' });
    const tlsSha256 = new crypto.X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
    const hits = [];
    const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
      hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => server.close(r)));
    const lan = (over = {}) => ({
      url: `https://127.0.0.1:${server.address().port}/blob/${H}?exp=1999999999&sig=${'ab'.repeat(32)}`,
      sha256: H, tlsSha256, exp: 1999999999, ...over,
    });
    return { hits, lan };
  }

  function run(lan) {
    const calls = [];
    const realGet = axios.get;
    axios.get = async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.endsWith('/api/v1/client/update/check')) {
        return { data: { ok: true, available: true, version: '9.9.9', downloadUrl: `https://github.com/x/releases/download/v9.9.9/${FILE}`, fileName: FILE, fileSize: INSTALLER.length, manifest, signature, ...(lan ? { lan } : {}) } };
      }
      return { data: Readable.from([INSTALLER]) };
    };
    cleanup.push(() => { axios.get = realGet; });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-upd-lan-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    // As in main.js (clientType / product 'community'); only the test needs
    // fixed adapters and the loopback address as "LAN".
    const u = new Updater({
      serverUrl: 'https://gate.example.com', apiKey: 't', log, clientType: 'community', product: PRODUCT, publicKey: PUB, downloadDir: dir,
      getInterfaces: () => IFACES, lanHostOk: (h) => h === '127.0.0.1',
    });
    return { u, calls };
  }

  it('main.js builds the core Updater without overriding its network options', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const call = main.match(/new Updater\(\{([\s\S]*?)\}\)/);
    assert.ok(call, 'new Updater({...}) not found');
    assert.match(call[1], /clientType:\s*'community'/);
    assert.ok(!/getInterfaces|fetchLan|lanHostOk/.test(call[1]));
    assert.equal(typeof Updater.prototype._downloadLan, 'function', 'core.ref points to a core without the home cache');
  });

  it('the check names the LAN addresses; the installer comes from the gateway, pinned and checked', async () => {
    const gw = await gateway();
    const { u, calls } = run(gw.lan());
    const info = await u.check();
    assert.equal(info.version, '9.9.9');
    assert.equal(calls[0].opts.headers['X-GC-Local'], '192.168.1.23');
    assert.equal(calls[0].opts.headers['X-Client-Type'], 'community');
    assert.equal(calls.length, 1, 'no download from the server');
    assert.equal(gw.hits.length, 1);
    assert.deepEqual(fs.readFileSync(u.downloadPath), INSTALLER);
    assert.equal((await u.prepareInstall()).ok, true);
  });

  it('another certificate or other bytes at the gateway: the normal download', async () => {
    const good = await gateway();
    const evil = await gateway(Buffer.from('MZ evil'));
    for (const lan of [good.lan({ tlsSha256: 'cd'.repeat(32) }), evil.lan()]) {
      const { u, calls } = run(lan);
      await u.check();
      assert.equal(calls.length, 2, 'check + download from downloadUrl');
      assert.match(calls[1].url, /^https:\/\/github\.com\//);
      assert.deepEqual(fs.readFileSync(u.downloadPath), INSTALLER);
      assert.deepEqual(fs.readdirSync(path.dirname(u.downloadPath)), [FILE]);
    }
    assert.equal(good.hits.length, 0, 'wrong pin: not a byte of the request is sent');
  });

  it('a hint for another file than the signed one: ignored, the normal download', async () => {
    const gw = await gateway();
    const { u, calls } = run(gw.lan({ sha256: 'f'.repeat(64) }));
    await u.check();
    assert.equal(calls.length, 2);
    assert.equal(gw.hits.length, 0);
    assert.deepEqual(fs.readFileSync(u.downloadPath), INSTALLER);
  });
});
