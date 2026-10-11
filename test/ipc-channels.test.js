'use strict';

// Every channel the Community preload invokes must be served by the core
// handlers (or by main.js itself for locale:*), and the late-created updater
// must be reachable through getUpdater.
//
// Needs @gatecontrol/client-core: node_modules (CI clones it to .core) or a
// sibling checkout ../gatecontrol-client-core. The private config-hash
// package is replaced by a stub.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const CORE_PKG = '@gatecontrol/client-core';

function findCore() {
	try {
		return path.dirname(require.resolve(`${CORE_PKG}/package.json`, { paths: [ROOT] }));
	} catch { /* not installed */ }
	for (const dir of [path.join(ROOT, '.core'), path.join(ROOT, '..', 'gatecontrol-client-core')]) {
		if (fs.existsSync(path.join(dir, 'src', 'ipc', 'base-handlers.js'))) return dir;
	}
	return null;
}

const coreDir = findCore();
let usable = !!coreDir;
if (coreDir) {
	const realResolve = Module._resolveFilename;
	Module._resolveFilename = function (request, ...rest) {
		if (request === '@callmetechie/gatecontrol-config-hash') return path.join(__dirname, 'fixtures', 'config-hash-stub.js');
		return realResolve.call(this, request, ...rest);
	};
	try { require.resolve('axios', { paths: [coreDir] }); } catch { usable = false; }
}
const skip = usable ? false : 'gatecontrol-client-core (with dependencies) not available';

// Load the real preload with a fake electron and call every exposed function
// once; returns the channels it invokes (core bridge + Community additions).
function preloadInvokedChannels() {
	const invoked = new Set();
	let api = null;
	const electron = {
		contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } },
		ipcRenderer: {
			invoke: (ch) => { invoked.add(ch); return Promise.resolve(); },
			send() {}, on() {}, removeListener() {},
		},
	};
	const realLoad = Module._load;
	Module._load = function (request, ...rest) {
		if (request === 'electron') return electron;
		return realLoad.call(this, request, ...rest);
	};
	const file = path.join(ROOT, 'src', 'main', 'preload.js');
	try {
		delete require.cache[file];
		require(file);
	} finally {
		Module._load = realLoad;
	}
	const walk = (obj) => {
		for (const v of Object.values(obj)) {
			if (typeof v === 'function') {
				const r = v(() => {});
				if (typeof r === 'function') r();
			} else if (v && typeof v === 'object') walk(v);
		}
	};
	walk(api);
	return [...invoked];
}

// Stand-in for core NotificationCenter (the IPC layer only forwards to it).
function fakeNotificationCenter() {
	return {
		pushClient: { requestTest: async () => ({ ok: true, seq: 130 }) },
		on() {},
		list: () => ({ items: [], unread: 0, topics: [] }),
		refresh: async () => ({ ok: true }),
		markRead: async () => ({ ok: true, updated: 0, unread: 0 }),
		performAction: async () => ({ ok: true }),
		getPrefs: () => ({ enabled: true }),
		setPrefs: () => ({ ok: true, prefs: {} }),
		status: () => ({ state: 'disabled', reason: 'not_configured' }),
		unreadCount: () => 0,
		dndState: () => ({ active: false, until: null }),
		setDnd: () => ({ ok: true, active: false, until: null }),
		resetForNewServer() {},
	};
}

describe('Community IPC channels', { skip }, () => {
	function register(extra = {}) {
		const { registerBaseHandlers } = require(path.join(coreDir, 'src', 'ipc', 'base-handlers.js'));
		const handlers = {};
		const ipcMain = {
			handle(ch, fn) {
				if (handlers[ch]) throw new Error(`second handler for '${ch}'`);
				handlers[ch] = fn;
			},
			on() {},
		};
		const stored = {};
		registerBaseHandlers(ipcMain, {
			app: { getVersion: () => '1.0.0', setLoginItemSettings() {} },
			dialog: {},
			getMainWindow: () => null,
			store: { get: (k) => stored[k], set: (k, v) => { stored[k] = v; }, store: stored },
			wgService: {},
			apiClient: {},
			killSwitch: {},
			log: { info() {}, warn() {}, error() {}, debug() {} },
			connectTunnel() {}, disconnectTunnel() {}, toggleKillSwitch() {}, toggleRdpAllow() {},
			installUpdate() {}, getTunnelState: () => ({}),
			openPortal: async () => true,
			wgConfigFile: 'wg.conf',
			// main.js always passes the notification center (notify:* channels)
			notificationCenter: fakeNotificationCenter(),
			...extra,
		});
		return handlers;
	}

	it('serves every channel the preload invokes', () => {
		const invoked = preloadInvokedChannels();
		assert.ok(invoked.includes('tunnel:connect') && invoked.includes('locale:get'));
		const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
		const own = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
		const handlers = register();
		for (const ch of own) assert.equal(handlers[ch], undefined, `${ch} would be registered twice`);
		for (const ch of invoked) assert.ok(handlers[ch] || own.includes(ch), ch);
		for (const ch of ['notify:list', 'notify:read', 'notify:action', 'notify:prefs:get', 'notify:prefs:set', 'notify:test', 'notify:status', 'notify:dnd']) {
			assert.ok(invoked.includes(ch), `preload: ${ch}`);
			assert.equal(typeof handlers[ch], 'function', ch);
		}
	});

	it('main passes openPortal so the portal button gets a one-time login link', () => {
		const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
		assert.match(main, /openPortal: \(\) => openPortalSafe\(\)/);
		assert.match(main, /createPortalOpener\(/);
	});

	it('update:check sees an updater that exists only after registration', async () => {
		let updater = null;
		const handlers = register({ getUpdater: () => updater });
		assert.equal(await handlers['update:check'](), null);
		updater = { getUpdateInfo: () => ({ version: '9.0.0' }) };
		assert.deepEqual(await handlers['update:check'](), { version: '9.0.0' });
	});

	it('app:device-id hands the renderer only the 8-character short form', async () => {
		const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
		assert.match(main, /ipcMain\.handle\('app:device-id', \(\) => shortDeviceId\(getMachineFingerprint, log\)\)/);
		const { shortDeviceId } = require('../src/main/device-id');
		const fingerprint = 'a41f09c2' + '7e3b5d19c0aa48f2b6e1d3c5f7092a4b6c8d0e1f2a3b4c5d6e7f8091';
		assert.equal(fingerprint.length, 64);
		const handler = () => shortDeviceId(() => fingerprint, { warn() {} });

		// The preload passes the main-process answer through unchanged.
		let api = null;
		const electron = {
			contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } },
			ipcRenderer: {
				invoke: (ch) => Promise.resolve(ch === 'app:device-id' ? handler() : undefined),
				send() {}, on() {}, removeListener() {},
			},
		};
		const realLoad = Module._load;
		Module._load = function (request, ...rest) {
			if (request === 'electron') return electron;
			return realLoad.call(this, request, ...rest);
		};
		const file = path.join(ROOT, 'src', 'main', 'preload.js');
		try {
			delete require.cache[file];
			require(file);
		} finally {
			Module._load = realLoad;
		}
		const seen = await api.getDeviceId();
		assert.equal(seen, 'a41f09c2');
		assert.match(seen, /^[0-9a-f]{8}$/);
		assert.ok(!String(seen).includes(fingerprint.slice(8)));
		// Nothing on the renderer side reads the fingerprint itself.
		for (const f of ['src/main/preload.js', 'src/renderer/renderer.js']) {
			const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
			assert.doesNotMatch(src, /getMachineFingerprint|machine-id|X-Machine-Fingerprint/, f);
		}
		// Failure path: null, no throw.
		assert.equal(shortDeviceId(() => { throw new Error('reg query failed'); }, { warn() {} }), null);
	});

		it('main.js keeps the kill-switch preference on quit/update', () => {
		const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
		assert.doesNotMatch(main, /store\.set\('tunnel\.killSwitch',\s*false\)/);
	});
});
