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
			wgConfigFile: 'wg.conf',
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
	});

	it('update:check sees an updater that exists only after registration', async () => {
		let updater = null;
		const handlers = register({ getUpdater: () => updater });
		assert.equal(await handlers['update:check'](), null);
		updater = { getUpdateInfo: () => ({ version: '9.0.0' }) };
		assert.deepEqual(await handlers['update:check'](), { version: '9.0.0' });
	});

	it('main.js keeps the kill-switch preference on quit/update', () => {
		const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
		assert.doesNotMatch(main, /store\.set\('tunnel\.killSwitch',\s*false\)/);
	});
});
