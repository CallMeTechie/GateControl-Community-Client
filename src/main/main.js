/**
 * GateControl Client – Electron Main Process (Community)
 *
 * Thin wrapper around @gatecontrol/client-core.
 * All business logic lives in the core package.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, Notification, screen, nativeTheme } = require('electron');

// E2E test hooks (unpackaged dev runs only, see e2e-guard.js). Must run
// before any core service is required; a packaged build never loads them.
const e2e = require('./e2e-guard').loadE2eHooks({ app });
const path = require('path');

const {
  WireGuardService,
  ApiClient,
  KillSwitch,
  RdpAllow,
  ConnectionMonitor,
  Updater,
  DnsPolicy,
  createLogger,
  createStores,
  registerBaseHandlers,
  validateWgConfig,
  // Shared helpers (unit-tested in core): pure tunnel/portal logic,
  // kill-switch startup recovery, tray icon, update key loader.
  reconnectDelay,
  shouldOpenPortal,
  recoverKillSwitch,
  createTrayIcon,
  formatBytesShort,
  loadUpdatePublicKey,
  updateMenuItems,
  mandatoryNotice,
} = require('@gatecontrol/client-core');

const { i18n } = require('@gatecontrol/client-core');
const { t, setLocale, getLocale, resolveLocale } = i18n;

// ── Logging ──────────────────────────────────────────────────
const log = createLogger();

// ── Single Instance Lock ─────────────────────────────────────
// app.quit() is asynchronous — without exiting here the second instance
// would go on to create stores, services and IPC handlers.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.exit(0);
	process.exit(0);
}

// ── Store ────────────────────────────────────────────────────
const { store } = createStores({
  userDataPath: app.getPath('userData'),
  log,
});

// ── Globale Referenzen ───────────────────────────────────────
let mainWindow = null;
let tray = null;
let wgService = null;
let killSwitch = null;
let rdpAllow = null;
let apiClient = null;
let dnsPolicy = null;
let connectionMonitor = null;
let updater = null;
let pendingUpdate = null;
// Version for which the "Update erforderlich" notification was already shown
// in this session (shown again on every app start while still required).
let mandatoryNotifiedVersion = null;

// ── State ────────────────────────────────────────────────────
let tunnelState = {
	connected: false,
	interface: null,
	endpoint: null,
	handshake: null,
	rxBytes: 0,
	txBytes: 0,
	uptime: 0,
	connectedSince: null,
};
let isReconnecting = false;

// ── Portal state ─────────────────────────────────────────────
let portalUrl = null;
let autoOpenPortal = false;
let portalOpenedSince = null;

// ── Pfade ────────────────────────────────────────────────────
const RESOURCES_PATH = app.isPackaged
	? path.join(process.resourcesPath, 'resources')
	: path.join(__dirname, '..', '..', 'resources');

const WG_CONFIG_DIR = path.join(app.getPath('userData'), 'wireguard');
const WG_CONFIG_FILE = path.join(WG_CONFIG_DIR, 'gatecontrol0.conf');

// ── Helpers ──────────────────────────────────────────────────
function openPortalSafe() {
	if (portalUrl && /^https:\/\//i.test(portalUrl)) {
		require('electron').shell.openExternal(portalUrl).catch(() => {});
	}
}

// ── Tray Icon (Sun/Star design, drawn by core) ──────────────
function getIcon(state) {
	return createTrayIcon(nativeImage, state);
}

function updateTray(state) {
	if (!tray) return;

	tray.setImage(getIcon(state));

	const statusText = state === 'connected' ? t('status.connected')
		: state === 'connecting' ? t('status.connecting')
		: t('status.disconnected');

	let tooltip = `GateControl – ${statusText}`;
	if (tunnelState.connected) {
		const serverUrl = store.get('server.url', '');
		if (serverUrl) tooltip += `\n${serverUrl}`;
		if (tunnelState.connectedSince) {
			const dur = Math.floor((Date.now() - new Date(tunnelState.connectedSince).getTime()) / 1000);
			const h = Math.floor(dur / 3600);
			const m = Math.floor((dur % 3600) / 60);
			const duration = `${h > 0 ? h + 'h ' : ''}${m}m`;
			tooltip += `\n${t('tray.connectedSince', { duration })}`;
		}
		const rx = tunnelState.rxBytes || 0;
		const tx = tunnelState.txBytes || 0;
		tooltip += `\n↓ ${formatBytesShort(rx)}  ↑ ${formatBytesShort(tx)}`;
	}
	tray.setToolTip(tooltip);

	// Ready update: a mandatory one goes to the top, an optional one stays below
	const updateItems = updateMenuItems({
		update: pendingUpdate,
		mandatory: !!updater?.isMandatory(),
		t,
		install: () => installUpdate(),
	});

	const contextMenu = Menu.buildFromTemplate([
		{
			label: `GateControl – ${statusText}`,
			enabled: false,
			icon: getIcon(state),
		},
		{ type: 'separator' },
		...updateItems.top,
		{
			label: state === 'connected' ? '⬤ ' + t('status.connected') : '○ ' + t('status.disconnected'),
			enabled: false,
		},
		...((store.get('server.url', '') || tunnelState.endpoint) ? [{
			label: `Server: ${store.get('server.url', '') || tunnelState.endpoint}`,
			enabled: false,
		}] : []),
		...(tunnelState.handshake ? [{
			label: `Handshake: ${tunnelState.handshake}`,
			enabled: false,
		}] : []),
		{ type: 'separator' },
		{
			label: state === 'connected' ? t('action.disconnect') : t('action.connect'),
			click: () => state === 'connected' ? disconnectTunnel() : connectTunnel(),
		},
		{ type: 'separator' },
		{
			label: t('killswitch.label'),
			type: 'checkbox',
			checked: store.get('tunnel.killSwitch', false),
			click: (item) => toggleKillSwitch(item.checked),
		},
		{ type: 'separator' },
		{
			label: t('tray.openWindow'),
			click: () => showWindow(),
		},
		{
			label: t('tray.settings'),
			click: () => {
				showWindow();
				mainWindow?.webContents.send('navigate', 'settings');
			},
		},
		...updateItems.bottom,
		...(portalUrl ? [
			{ type: 'separator' },
			{
				label: t('portal.open'),
				click: () => openPortalSafe(),
			},
		] : []),
		{ type: 'separator' },
		{
			label: t('tray.quit'),
			click: () => quitApp(),
		},
	]);

	tray.setContextMenu(contextMenu);
}

// ── Fenster ──────────────────────────────────────────────────
function createWindow() {
	// Sidebar layout (redesign): default 1040×720 DIP, resizable down to a
	// compact icon-rail layout at 760×560. Size is remembered in DIP.
	const DEFAULT_SIZE = { width: 1040, height: 720 };
	const MIN_SIZE = { width: 760, height: 560 };
	const saved = store.get('app.windowSize', null);
	const work = screen.getPrimaryDisplay().workAreaSize;
	const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));
	const width = clamp(saved?.width || DEFAULT_SIZE.width, MIN_SIZE.width, Math.max(MIN_SIZE.width, work.width));
	const height = clamp(saved?.height || DEFAULT_SIZE.height, MIN_SIZE.height, Math.max(MIN_SIZE.height, work.height));

	const themeSetting = store.get('app.theme', 'dark');
	const isLight = themeSetting === 'light' || (themeSetting === 'system' && !nativeTheme.shouldUseDarkColors);

	mainWindow = new BrowserWindow({
		width,
		height,
		minWidth: MIN_SIZE.width,
		minHeight: MIN_SIZE.height,
		resizable: true,
		frame: false,
		backgroundColor: isLight ? '#F3F5F8' : '#0D1015',
		titleBarStyle: 'hidden',
		show: false,
		icon: app.isPackaged
			? path.join(process.resourcesPath, 'resources', 'icons', 'app-icon.png')
			: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: false,
		},
	});

	mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

	mainWindow.once('ready-to-show', () => {
		if (!store.get('app.startMinimized', true)) {
			mainWindow.show();
		}
	});

	mainWindow.on('resize', () => {
		if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
		const [w, h] = mainWindow.getSize();
		store.set('app.windowSize', { width: w, height: h });
	});

	mainWindow.on('close', (e) => {
		if (!app.isQuitting) {
			e.preventDefault();
			mainWindow.hide();
		}
	});

	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

function showWindow() {
	if (!mainWindow) {
		createWindow();
		mainWindow.show();
	} else {
		mainWindow.show();
		mainWindow.focus();
	}
}

// ── WireGuard Tunnel ─────────────────────────────────────────
async function connectTunnel() {
	if (isReconnecting) {
		log.debug('Reconnect läuft bereits, überspringe connectTunnel');
		return;
	}
	try {
		log.info('Tunnel-Verbindung wird aufgebaut...');
		connectionMonitor.stop();
		updateTray('connecting');
		broadcastState('connecting');

		const serverUrl = store.get('server.url');
		const apiKey = store.get('server.apiKey');

		if (serverUrl && apiKey) {
			let fetchedConfig = null;
			try {
				fetchedConfig = await apiClient.fetchConfig();
			} catch (err) {
				log.warn('Config-Abruf fehlgeschlagen, nutze lokale Config:', err.message);
			}
			if (fetchedConfig) {
				// Fail-closed: validate before overwriting the existing config.
				// A bad fetch must NOT clobber a good local config; abort the connect.
				const validation = validateWgConfig(fetchedConfig);
				if (!validation.ok) {
					const msg = 'Invalid WireGuard config: ' + validation.errors.join(', ');
					log.error('Config-Update abgelehnt, behalte lokale Config: ' + msg);
					updateTray('disconnected');
					broadcastState('error', msg);
					showNotification(t('notify.connectionError'), msg);
					return;
				}
				if (validation.warnings && validation.warnings.length > 0) {
					log.warn('Config-Warnungen: ' + validation.warnings.join(', '));
				}
				await wgService.writeConfig(WG_CONFIG_FILE, fetchedConfig);
				log.info('Konfiguration vom Server aktualisiert');
			}
		}

		if (store.get('tunnel.killSwitch', false)) {
			await killSwitch.enable(WG_CONFIG_FILE);
			log.info('Kill-Switch aktiviert');
		}

		await wgService.connect(WG_CONFIG_FILE, store.get('tunnel.splitTunnel') ? store.get('tunnel.splitRoutes', '') : null);

		tunnelState.connected = true;
		tunnelState.connectedSince = new Date();

		updateTray('connected');
		broadcastState('connected');

		// ── Portal auto-open (Task 7) ────────────────────────────
		async function refreshPortalUrl() {
			await apiClient.getPermissions();
			portalUrl = apiClient.portalUrl;
			autoOpenPortal = apiClient.autoOpenPortal;
			// ponytail: getPermissions() never throws (catches internally); on failure
			// apiClient.portalUrl retains its previous value (preserve-last-known).
			if (!portalUrl) log.warn('portal url fetch returned empty');
		}
		await refreshPortalUrl();
		if (!portalUrl) { await new Promise(r => setTimeout(r, 1500)); await refreshPortalUrl(); }
		updateTray('connected'); // refresh so portal item appears
		if (mainWindow) mainWindow.webContents.send('portal-url', portalUrl);
		const since = tunnelState.connectedSince ? tunnelState.connectedSince.getTime() : Date.now();
		if (shouldOpenPortal({ portalUrl, autoOpenPortal, connectedSince: since, lastOpenedSince: portalOpenedSince })) { portalOpenedSince = since; openPortalSafe(); }

		connectionMonitor.start();

		showNotification(t('notify.connected'), t('notify.connected'));
		log.info('Tunnel erfolgreich verbunden');

		// Report OS hostname for internal DNS (best-effort, once per session).
		// The server rate-limits to 3/min/token; calling once on connect is
		// well within the budget and lets the admin see DESKTOP-xxx show up
		// automatically in the peer list.
		try {
			const os = require('os');
			const raw = os.hostname();
			const sanitized = ApiClient.sanitizeHostnameForDns(raw);
			if (sanitized && apiClient) {
				apiClient.reportHostname(sanitized).catch(() => { /* best-effort */ });
			}
		} catch (err) {
			log.debug('Hostname report skipped:', err.message);
		}

		// Install NRPT rule for *.gc.internal so Windows routes those
		// queries to the VPN-internal dnsmasq instead of the default
		// resolver fan-out (which caches a public-side NXDOMAIN first).
		try {
			if (DnsPolicy && !dnsPolicy) dnsPolicy = new DnsPolicy(log);
			if (dnsPolicy) {
				dnsPolicy.add('.gc.internal', '10.8.0.1').catch((e) =>
					log.debug('NRPT install failed:', e && e.message));
			}
		} catch (err) {
			log.debug('NRPT skipped:', err.message);
		}

		checkPeerExpiry();

	} catch (err) {
		log.error('Tunnel-Verbindung fehlgeschlagen:', err);
		updateTray('disconnected');
		broadcastState('error', err.message);
		showNotification(t('notify.connectionError'), err.message);
	}
}

async function disconnectTunnel() {
	try {
		log.info('Tunnel wird getrennt...');

		connectionMonitor.stop();

		if (dnsPolicy) {
			try { await dnsPolicy.removeAll(); } catch (e) { log.debug('NRPT cleanup:', e.message); }
		}

		await wgService.disconnect();

		if (killSwitch.enabled || store.get('tunnel.killSwitch', false)) {
			await killSwitch.disable();
			log.info('Kill-Switch deaktiviert');
		}

		tunnelState.connected = false;
		tunnelState.connectedSince = null;
		tunnelState.rxBytes = 0;
		tunnelState.txBytes = 0;

		portalOpenedSince = null;
		portalUrl = null;
		if (mainWindow) mainWindow.webContents.send('portal-url', null);

		updateTray('disconnected');
		broadcastState('disconnected');

		showNotification(t('notify.disconnected'), t('notify.disconnected'));
		log.info('Tunnel getrennt');

	} catch (err) {
		log.error('Fehler beim Trennen:', err);
	}
}

async function toggleKillSwitch(enabled) {
	store.set('tunnel.killSwitch', enabled);

	if (enabled && tunnelState.connected) {
		await killSwitch.enable(WG_CONFIG_FILE);
	} else if (!enabled) {
		await killSwitch.disable();
	}

	broadcastState(tunnelState.connected ? 'connected' : 'disconnected');
}

async function toggleRdpAllow(enabled) {
	store.set('tunnel.rdpAllow', enabled);

	if (enabled) {
		await rdpAllow.enable(WG_CONFIG_FILE);
	} else {
		await rdpAllow.disable();
	}

	broadcastState(tunnelState.connected ? 'connected' : 'disconnected');
}

// ── Reconnect Logic ──────────────────────────────────────────
async function handleDisconnect() {
	if (isReconnecting) return;
	isReconnecting = true;

	log.warn('Verbindungsabbruch erkannt, versuche Reconnect...');

	tunnelState.connected = false;
	updateTray('connecting');
	broadcastState('reconnecting');

	const maxRetries = 10;

	for (let i = 0; i < maxRetries; i++) {
		const delay = reconnectDelay(i);
		log.info(`Reconnect-Versuch ${i + 1}/${maxRetries} in ${delay}ms...`);

		await new Promise(r => setTimeout(r, delay));

		try {
			await wgService.disconnect().catch(() => {});
			await wgService.connect(WG_CONFIG_FILE, store.get('tunnel.splitTunnel') ? store.get('tunnel.splitRoutes', '') : null);

			tunnelState.connected = true;
			tunnelState.connectedSince = new Date();
			isReconnecting = false;
			updateTray('connected');
			broadcastState('connected');
			connectionMonitor.start();

			showNotification(t('notify.reconnected'), t('notify.reconnected'));
			log.info('Reconnect erfolgreich');
			return;
		} catch (err) {
			log.warn(`Reconnect-Versuch ${i + 1} fehlgeschlagen:`, err.message);
		}
	}

	log.error('Alle Reconnect-Versuche fehlgeschlagen');
	isReconnecting = false;
	updateTray('disconnected');
	broadcastState('error', t('notify.reconnectFailed'));
	showNotification(t('notify.connectionError'), t('notify.reconnectFailed'));
}

// ── Notifications ────────────────────────────────────────────
function showNotification(title, body) {
	if (Notification.isSupported()) {
		new Notification({
			title: `GateControl: ${title}`,
			body,
			icon: app.isPackaged
				? path.join(process.resourcesPath, 'resources', 'icons', 'app-icon.png')
				: path.join(__dirname, '..', '..', 'build', 'icon.png'),
		}).show();
	}
}

// ── Peer-Ablauf-Warnung ─────────────────────────────────
async function checkPeerExpiry() {
	try {
		const peerInfo = await apiClient?.getPeerInfo();
		if (!peerInfo?.expiresAt) return;

		const expiresAt = new Date(peerInfo.expiresAt);
		const now = new Date();
		const daysLeft = Math.ceil((expiresAt - now) / 86400000);

		if (daysLeft <= 0) {
			showNotification(t('notify.peerExpiredTitle'), t('notify.peerExpiredBody'));
			mainWindow?.webContents.send('peer-expiry', { daysLeft: 0, expiresAt: peerInfo.expiresAt });
		} else if (daysLeft <= 1) {
			showNotification(t('notify.peerExpiresTodayTitle'), t('notify.peerExpiresTodayBody'));
			mainWindow?.webContents.send('peer-expiry', { daysLeft, expiresAt: peerInfo.expiresAt });
		} else if (daysLeft <= 3) {
			showNotification(t('notify.peerExpiresSoonTitle'), t('notify.peerExpiresSoonBody', { days: daysLeft }));
			mainWindow?.webContents.send('peer-expiry', { daysLeft, expiresAt: peerInfo.expiresAt });
		} else if (daysLeft <= 7) {
			showNotification(t('notify.peerExpiryNotice'), t('notify.peerExpiresSoonBody', { days: daysLeft }));
			mainWindow?.webContents.send('peer-expiry', { daysLeft, expiresAt: peerInfo.expiresAt });
		}

		if (daysLeft <= 7) {
			log.info(`Peer läuft ab in ${daysLeft} Tagen (${peerInfo.expiresAt})`);
		}
	} catch (err) {
		log.debug('Peer-Ablauf-Prüfung fehlgeschlagen:', err.message);
	}
}

// ── Auto-Update UI ──────────────────────────────────────────
function showUpdateNotification(release) {
	if (release.mandatory) {
		notifyMandatoryUpdate(release);
	} else {
		showNotification(t('update.available', { version: release.version }), t('update.readyToInstall'));
	}
	mainWindow?.webContents.send('update-ready', {
		version: release.version,
		releaseNotes: release.releaseNotes,
		mandatory: release.mandatory === true,
		channel: release.channel || null,
		minVersion: release.minVersion || null,
	});
}

// "Update erforderlich" notification, once per version and app session.
function notifyMandatoryUpdate(info) {
	if (!info?.version || mandatoryNotifiedVersion === info.version) return;
	mandatoryNotifiedVersion = info.version;
	const notice = mandatoryNotice(info, t);
	showNotification(notice.title, notice.body);
}

async function installUpdate() {
	// Only the updater's verified state counts: a manual check may leave
	// the cached release info unset or without an installer path.
	if (!updater?.isUpdateReady()) {
		log.warn('Update-Installation angefordert, aber kein geprüftes Update bereit');
		return false;
	}

	log.info('Update-Installation gestartet...');

	if (tunnelState.connected) {
		await disconnectTunnel();
	}

	// Lift the firewall rules for the installer, but keep the user's
	// kill-switch preference — the new version re-enables it on connect.
	if (killSwitch?.enabled) {
		try {
			await killSwitch.disable();
		} catch (err) {
			log.error('Kill-Switch konnte vor dem Update nicht deaktiviert werden:', err.message);
		}
	}

	// Re-hashes the installer before starting it.
	if (!updater.install()) return false;

	setTimeout(() => quitApp(), 1500);
	return true;
}

// ── IPC ──────────────────────────────────────────────────────
function broadcastState(status, error = null) {
	const state = {
		status,
		error,
		connected: tunnelState.connected,
		endpoint: store.get('server.url', '') || tunnelState.endpoint,
		handshake: tunnelState.handshake,
		rxBytes: tunnelState.rxBytes,
		txBytes: tunnelState.txBytes,
		rxSpeed: tunnelState.rxSpeed || 0,
		txSpeed: tunnelState.txSpeed || 0,
		connectedSince: tunnelState.connectedSince,
		killSwitch: store.get('tunnel.killSwitch', false),
		rdpAllow: store.get('tunnel.rdpAllow', false),
	};

	mainWindow?.webContents.send('tunnel-state', state);
}

// ── App Lifecycle ────────────────────────────────────────────
async function initServices() {
	const fs = require('fs');
	if (!fs.existsSync(WG_CONFIG_DIR)) {
		fs.mkdirSync(WG_CONFIG_DIR, { recursive: true });
	}

	wgService = new WireGuardService(log, { resourcesPath: RESOURCES_PATH });
	killSwitch = new KillSwitch(log, { edition: 'community' });
	rdpAllow = new RdpAllow(log, { edition: 'community' });
	apiClient = new ApiClient(
		store.get('server.url', ''),
		store.get('server.apiKey', ''),
		log,
		store.get('server.peerId', '') || null,
		{ clientVersion: require('../../package.json').version, clientType: 'community' }
	);

	connectionMonitor = new ConnectionMonitor({
		interval: store.get('app.checkInterval', 30) * 1000,
		apiClient,
		onDisconnect: handleDisconnect,
		onPeerDisabled: async (peerInfo) => {
			log.warn(`Peer disabled on server (id: ${peerInfo?.id}, name: ${peerInfo?.name}) — disconnecting`);
			await disconnectTunnel();
			new Notification({
				title: 'GateControl',
				body: t('notify.peerDisabled'),
			}).show();
		},
		onStats: (stats) => {
			const now = Date.now();
			if (tunnelState._lastStatsTime && stats.rxBytes !== undefined) {
				const dt = (now - tunnelState._lastStatsTime) / 1000;
				if (dt > 0) {
					stats.rxSpeed = Math.max(0, ((stats.rxBytes || 0) - (tunnelState.rxBytes || 0)) / dt);
					stats.txSpeed = Math.max(0, ((stats.txBytes || 0) - (tunnelState.txBytes || 0)) / dt);
				}
			}
			tunnelState = { ...tunnelState, ...stats, _lastStatsTime: now };
			const trayState = tunnelState.connected ? 'connected' : 'disconnected';
			updateTray(trayState);
			broadcastState(trayState);
		},
		wgService,
		log,
	});

	const savedLocale = store.get('app.locale');
	if (savedLocale) {
		setLocale(savedLocale);
	} else {
		setLocale(resolveLocale(app.getLocale()));
	}
}

app.whenReady().then(async () => {
	app.setAppUserModelId('GateControl Client');
	log.info('GateControl Client wird gestartet...');

	await initServices();

	// Kill-Switch Cleanup: Reste eines Absturzes entfernen und die vorher
	// gesicherte Firewall-Policy wiederherstellen (Tunnel ist nach dem
	// Start nie aktiv; bei Einstellung "an" aktiviert connectTunnel ihn neu)
	await recoverKillSwitch({ killSwitch, store, wgService, log });

	// RDP Allow mit der Einstellung abgleichen: verwaiste Regel entfernen,
	// aktive übernehmen bzw. wiederherstellen. Die alte gemeinsame Regel
	// GateControl_RDP_Allow_In_3389 entfernt der Core nur, wenn die
	// Pro-Edition weder installiert ist noch läuft.
	try {
		const rdpWanted = store.get('tunnel.rdpAllow', false);
		const rdpActive = await rdpAllow.reconcile({ wanted: rdpWanted, configPath: WG_CONFIG_FILE });
		if (rdpWanted && !rdpActive) store.set('tunnel.rdpAllow', false);
	} catch (err) {
		log.debug('RDP Allow Cleanup:', err.message);
	}

	// Updater before the IPC handlers: update:check and the post-setup
	// updater.configure() need it (started further below).
	// Nur signierte Updates: ohne echten Public Key bleibt der Updater aus.
	updater = new Updater({
		serverUrl: store.get('server.url', ''),
		apiKey: store.get('server.apiKey', ''),
		log,
		clientType: 'community',
		product: 'community',
		// Ed25519-Public-Key für signierte Updates (build/update-signing.pub).
		publicKey: loadUpdatePublicKey({ appRoot: path.join(__dirname, '..', '..') }),
	});

	// IPC Handler registrieren (from core)
	registerBaseHandlers(ipcMain, {
		app,
		dialog,
		getMainWindow: () => mainWindow,
		store,
		wgService,
		apiClient,
		killSwitch,
		getUpdater: () => updater,
		log,
		connectTunnel,
		disconnectTunnel,
		toggleKillSwitch,
		toggleRdpAllow,
		installUpdate,
		getTunnelState: () => tunnelState,
		wgConfigFile: WG_CONFIG_FILE,
	});

	// Fenster maximieren/wiederherstellen (eigene Titelleiste)
	ipcMain.on('window:toggle-maximize', () => {
		if (!mainWindow) return;
		if (mainWindow.isMaximized()) mainWindow.unmaximize();
		else mainWindow.maximize();
	});

	// Locale IPC Handler
	ipcMain.handle('locale:set', (_, locale) => {
		setLocale(locale);
		store.set('app.locale', getLocale());
		updateTray(tunnelState.connected ? 'connected' : 'disconnected');
		mainWindow?.webContents.send('locale:changed', getLocale());
	});
	ipcMain.handle('locale:get', () => getLocale());

	// Tray
	tray = new Tray(getIcon('disconnected'));
	tray.on('double-click', () => showWindow());
	updateTray('disconnected');

	// Fenster
	createWindow();

	// Auto-Connect
	if (store.get('tunnel.autoConnect', true)) {
		const configExists = require('fs').existsSync(WG_CONFIG_FILE);
		const hasServer = store.get('server.url', '') !== '';

		if (configExists || hasServer) {
			log.info('Auto-Connect aktiv, verbinde...');
			setTimeout(() => connectTunnel(), 2000);
		} else {
			log.info('Keine Konfiguration vorhanden, überspringe Auto-Connect');
			showWindow();
		}
	}

	// Config-Polling
	const pollInterval = store.get('app.configPollInterval', 300) * 1000;
	if (store.get('server.url', '')) {
		setInterval(async () => {
			try {
				const newConfig = await apiClient.checkConfigUpdate();
				if (newConfig) {
					// Validate before applying — fail-closed via shared validator.
					const validation = validateWgConfig(newConfig);
					if (!validation.ok) {
						log.warn('Config update rejected: ' + validation.errors.join(', '));
					} else {
						if (validation.warnings && validation.warnings.length > 0) {
							log.warn('Config update warnings: ' + validation.warnings.join(', '));
						}
						log.info('Neue Konfiguration vom Server erhalten');
						await wgService.writeConfig(WG_CONFIG_FILE, newConfig);
						if (tunnelState.connected) {
							await disconnectTunnel();
							await connectTunnel();
						}
					}
				}
			} catch (err) {
				log.debug('Config-Poll fehlgeschlagen:', err.message);
			}
		}, pollInterval);
	}

	// Auto-Update. Mandatory updates (server: below the minimum version) are
	// never installed automatically: the installer ends the app and the
	// tunnel, so the user starts it (banner, sidebar card, tray). The notice
	// cannot be dismissed and is shown again on every start while required.
	updater.start((release) => {
		pendingUpdate = release;
		log.info(`Update bereit: v${release.version}${release.mandatory ? ' (Pflicht-Update)' : ''}`);
		updateTray(tunnelState.connected ? 'connected' : 'disconnected');
		showUpdateNotification(release);
	}, {
		onPolicyChange: (policy) => {
			mainWindow?.webContents.send('update:policy', policy);
			updateTray(tunnelState.connected ? 'connected' : 'disconnected');
			if (policy.mandatory && pendingUpdate) {
				notifyMandatoryUpdate({ version: policy.version, minVersion: policy.minVersion });
			}
		},
	});

	// Autostart (nicht im E2E-Test)
	if (!e2e && store.get('app.startWithWindows', true)) {
		app.setLoginItemSettings({
			openAtLogin: true,
			path: process.execPath,
			args: ['--minimized'],
		});
	}

	log.info('GateControl Client bereit');
});

app.on('second-instance', () => {
	showWindow();
});

app.on('window-all-closed', (e) => {
	e.preventDefault();
});

async function quitApp() {
	app.isQuitting = true;

	updater?.stop();

	if (tunnelState.connected) {
		await disconnectTunnel();
	}

	// Remove the firewall rules for this session only; the kill-switch
	// preference stays on and is applied again on the next connect.
	if (killSwitch?.enabled) {
		try {
			await killSwitch.disable();
		} catch (err) {
			// Zustand bleibt gespeichert — der nächste Start räumt auf
			log.error('Kill-Switch konnte beim Beenden nicht deaktiviert werden:', err.message);
		}
	}

	if (rdpAllow?.enabled) {
		try {
			await rdpAllow.disable();
			store.set('tunnel.rdpAllow', false);
		} catch {}
	}

	tray?.destroy();
	app.quit();
}

app.on('before-quit', async () => {
	app.isQuitting = true;
});
