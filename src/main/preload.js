/**
 * GateControl – Preload Script
 * Sichere Bridge zwischen Main und Renderer Process
 */

const { contextBridge, ipcRenderer } = require('electron');
const { i18n } = require('@gatecontrol/client-core');
const { t, setLocale, getLocale, onLocaleChange, registerTranslations, getSupportedLocales } = i18n;

registerTranslations('de', require('../i18n/de.json'));
registerTranslations('en', require('../i18n/en.json'));

contextBridge.exposeInMainWorld('gatecontrol', {
	// ── App ──────────────────────────────────────────────
	getVersion: () => ipcRenderer.invoke('app:version'),

	// ── Tunnel ───────────────────────────────────────────
	tunnel: {
		connect:    () => ipcRenderer.invoke('tunnel:connect'),
		disconnect: () => ipcRenderer.invoke('tunnel:disconnect'),
		getStatus:  () => ipcRenderer.invoke('tunnel:status'),
		onState:    (cb) => {
			const handler = (_, state) => cb(state);
			ipcRenderer.on('tunnel-state', handler);
			return () => ipcRenderer.removeListener('tunnel-state', handler);
		},
	},

	// ── Server ───────────────────────────────────────────
	server: {
		setup: (opts) => ipcRenderer.invoke('server:setup', opts),
		test:  (opts) => ipcRenderer.invoke('server:test', opts),
	},

	// ── Config ───────────────────────────────────────────
	config: {
		get:        (key)        => ipcRenderer.invoke('config:get', key),
		set:        (key, value) => ipcRenderer.invoke('config:set', key, value),
		getAll:     ()           => ipcRenderer.invoke('config:getAll'),
		importFile: ()           => ipcRenderer.invoke('config:import-file'),
		importQR:   (imageData)  => ipcRenderer.invoke('config:import-qr', imageData),
	},

	// ── WireGuard ────────────────────────────────────────
	wireguard: {
		check: () => ipcRenderer.invoke('wireguard:check'),
	},

	// ── Kill-Switch ──────────────────────────────────────
	killSwitch: {
		toggle: (enabled) => ipcRenderer.invoke('killswitch:toggle', enabled),
	},

	// ── Autostart ────────────────────────────────────────
	autostart: {
		set: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
	},

	// ── Logs ─────────────────────────────────────────────
	logs: {
		get: (opts) => ipcRenderer.invoke('logs:get', opts),
		export: () => ipcRenderer.invoke('logs:export'),
	},

	// ── Peer ─────────────────────────────────────────────
	peer: {
		onExpiry: (cb) => {
			const handler = (_, info) => cb(info);
			ipcRenderer.on('peer-expiry', handler);
			return () => ipcRenderer.removeListener('peer-expiry', handler);
		},
	},

	// ── Permissions ──────────────────────────────────────
	permissions: {
		get: () => ipcRenderer.invoke('permissions:get'),
	},

	// ── Traffic ──────────────────────────────────────────
	traffic: {
		stats: () => ipcRenderer.invoke('traffic:stats'),
	},

	// ── Services ─────────────────────────────────────────
	services: {
		list: () => ipcRenderer.invoke('services:list'),
	},

	// ── DNS ──────────────────────────────────────────────
	dns: {
		leakTest: () => ipcRenderer.invoke('dns:leak-test'),
	},

	// ── Update ───────────────────────────────────────────
	update: {
		check:   () => ipcRenderer.invoke('update:check'),
		install: () => ipcRenderer.invoke('update:install'),
		onReady: (cb) => {
			const handler = (_, info) => cb(info);
			ipcRenderer.on('update-ready', handler);
			return () => ipcRenderer.removeListener('update-ready', handler);
		},
	},

	// ── Shell ────────────────────────────────────────────
	shell: {
		openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
	},

	// ── Fenster ──────────────────────────────────────────
	window: {
		minimize: () => ipcRenderer.send('window:minimize'),
		close:    () => ipcRenderer.send('window:close'),
	},

	// ── Navigation ───────────────────────────────────────
	onNavigate: (cb) => {
		const handler = (_, page) => cb(page);
		ipcRenderer.on('navigate', handler);
		return () => ipcRenderer.removeListener('navigate', handler);
	},

	// ── i18n ────────────────────────────────────────────
	i18n: {
		t: (key, params) => t(key, params),
		getLocale: () => getLocale(),
		getSupportedLocales: () => getSupportedLocales(),
	},

	// ── Locale ──────────────────────────────────────────────
	locale: {
		set: (locale) => {
			setLocale(locale);
			ipcRenderer.invoke('locale:set', locale);
		},
		get: () => ipcRenderer.invoke('locale:get'),
		onChange: (cb) => {
			const ipcHandler = (_, loc) => {
				setLocale(loc);
				cb(loc);
			};
			ipcRenderer.on('locale:changed', ipcHandler);
			const unsub = onLocaleChange((loc) => cb(loc));
			return () => {
				ipcRenderer.removeListener('locale:changed', ipcHandler);
				unsub();
			};
		},
	},
});
