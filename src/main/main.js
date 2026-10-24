/**
 * GateControl Client – Electron Main Process (Community)
 *
 * Thin wrapper around @gatecontrol/client-core.
 * All business logic lives in the core package.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, Notification, screen, nativeTheme, shell, clipboard, safeStorage, powerMonitor, globalShortcut } = require('electron');
// Chats "Standort senden": navigator.geolocation from the Windows location
// service (Electron has no key for Google's network location).
if (process.platform === 'win32') app.commandLine.appendSwitch('enable-features', 'WinrtGeolocationImplementation');

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
  ClientPolicyService,
  clientPolicy: clientPolicyUtil,
  applyPolicyToStore,
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
  updateToast,
  createUpdateInstaller,
  installErrorText,
  createSupportBundleSender,
  collectSupportBundle,
  getMachineFingerprint,
  // Notification center: push stream from the own server, toasts, inbox,
  // tray entries (core docs/notification-center.md).
  PushClient,
  NotificationCenter,
  PushControl,
  notifyMenuItems,
  // Chats (GateControl Messenger): data, live events, outbox, chat toasts
  // (core docs/messenger.md).
  MessengerService,
  ChatNotifier,
} = require('@gatecontrol/client-core');
// Schule (plugin gatecontrol-schule): WebUntis timetable (core services/school.js).
const { SchoolService } = require('@gatecontrol/client-core');
// Vault (plugin gatecontrol-vault): end-to-end encrypted password manager
// (core docs/vault.md); quick search window on Strg+Alt+P.
const { VaultService, windowsHello } = require('@gatecontrol/client-core');
const { setupVaultQuick } = require('./vault-quick');
// GateDrop (plugin gatecontrol-gatedrop): send / receive files, LAN listener,
// "Senden an" in the Explorer (core services/gatedrop.js).
const { GateDropService, GateDropFirewall, gatedropShell } = require('@gatecontrol/client-core');
const { setupGateDrop } = require('./gatedrop');
const { shortDeviceId, withDeviceId } = require('./device-id');
const { setupNotifications } = require('./notifications');
const { setupMessenger } = require('./messenger');

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
let clientPolicy = null;
let connectionMonitor = null;
let updater = null;
let supportBundle = null; // "Support-Paket senden" (core src/support/sender.js)
let notifications = null; // notification center (./notifications.js), one per app lifetime
let chats = null; // messenger (./messenger.js), one per app lifetime
let school = null; // Schule (core SchoolService), one per app lifetime
let vault = null; // Vault (core VaultService), one per app lifetime
let vaultQuick = null; // Vault quick search window (./vault-quick.js)
let gatedrop = null; // GateDrop (./gatedrop.js), one per app lifetime
let configPollTimer = null; // config/check poll (see scheduleConfigPoll)
let configCheck = null; // running config check (shared by poll and push)
let trayState = 'disconnected'; // last state drawn in the tray (refresh on unread / DND changes)
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
// Opens the portal (https only). Asks the server for a fresh one-time login
// link right before every open and falls back to the plain portal URL
// (core utils/portal.js). Used by auto-open, tray and the "Portal öffnen" button.
// Push actions (open_portal: target) and "Ruhezeiten im Portal ändern" pass
// a portal tab ('/portal#benachrichtigungen'); it goes to the server as `next`.
function openPortalSafe(target) {
	let opts;
	if (typeof target === 'string') opts = { path: target };
	else if (target && typeof target.next === 'string') opts = { next: target.next };
	return createPortalOpener({ apiClient, getPortalUrl: () => portalUrl, log })
		.open(opts)
		.catch(() => false);
}

// ── Tray Icon (Sun/Star design, drawn by core) ──────────────
function getIcon(state) {
	return createTrayIcon(nativeImage, state);
}

function updateTray(state) {
	trayState = state;
	if (!tray) return;

	// Unread push notifications: dot on the tray icon.
	tray.setImage(createTrayIcon(nativeImage, state, { badge: !!notifications?.badge() || !!chats?.badge() }));

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
	const unreadLine = notifications?.tooltip(t);
	if (unreadLine) tooltip += `\n${unreadLine}`;
	const chatLine = chats?.tooltip(t);
	if (chatLine) tooltip += `\n${chatLine}`;
	tray.setToolTip(tooltip);

	// "Mitteilungen · n neu" and "Nicht stören für 1 Stunde" (core notifyMenuItems)
	const notifyItems = [
		...(chats ? chats.menuItems(t, () => { showWindow(); mainWindow?.webContents.send('navigate', 'chats'); }) : []),
		...(notifications ? notifications.menuItems(t) : []),
		...(gatedrop ? gatedrop.menuItems(t) : []),
	];

	// Ready update: a mandatory one goes to the top, an optional one stays below
	const updateItems = updateMenuItems({
		update: pendingUpdate,
		mandatory: !!updater?.isMandatory(),
		t,
		install: () => installUpdateFromTray(),
	});

	const contextMenu = Menu.buildFromTemplate([
		{
			label: `GateControl – ${statusText}`,
			enabled: false,
			icon: getIcon(state),
		},
		{ type: 'separator' },
		...updateItems.top,
		...(notifyItems.length ? [...notifyItems, { type: 'separator' }] : []),
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
			// Always-on policy: no manual disconnect
			enabled: !(state === 'connected' && policyLocks().disconnect),
			click: () => state === 'connected' ? disconnectTunnel() : connectTunnel(),
		},
		{ type: 'separator' },
		{
			label: policyLocks().killSwitch ? `${t('killswitch.label')} (${t('policy.lockedHint')})` : t('killswitch.label'),
			type: 'checkbox',
			checked: store.get('tunnel.killSwitch', false),
			enabled: !policyLocks().killSwitch,
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

	// Vault auto-lock "immediately" (0): the window goes to the tray / taskbar.
	mainWindow.on('hide', () => vault?.windowHidden());
	mainWindow.on('minimize', () => vault?.windowHidden());
}

/** The app's theme resolved to dark / light (Vault quick search window). */
function resolvedAppTheme() {
	const stored = store.get('app.theme', 'dark');
	if (stored === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
	return stored === 'light' ? 'light' : 'dark';
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
					showNotification(t('notify.connectionError'), msg, { collapseKey: 'tunnel' });
					return;
				}
				if (validation.warnings && validation.warnings.length > 0) {
					log.warn('Config-Warnungen: ' + validation.warnings.join(', '));
				}
				await wgService.writeConfig(WG_CONFIG_FILE, fetchedConfig);
				rememberInternalDns();
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

		showNotification(t('notify.connected'), t('notify.connected'), { collapseKey: 'tunnel' });
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

		// Install NRPT rule for *.<domain> (peer hostnames) so Windows routes
		// those queries to the VPN-internal dnsmasq instead of the default
		// resolver fan-out (which caches a public-side NXDOMAIN first).
		try {
			if (DnsPolicy && !dnsPolicy) dnsPolicy = new DnsPolicy(log);
			if (dnsPolicy) {
				installPeerDnsRule().catch((e) =>
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
		showNotification(t('notify.connectionError'), err.message, { collapseKey: 'tunnel' });
	}
}

// Internal DNS as the server reported it with the config: { domain, server },
// null (off), or unset for servers that do not say — kept for connects
// where the config cannot be fetched.
function rememberInternalDns() {
	if (apiClient && apiClient.internalDns !== undefined) store.set('tunnel.internalDns', apiClient.internalDns);
	else store.delete('tunnel.internalDns');
}

// Peer hostnames (<host>.<domain>) → the server's dnsmasq, with the domain and
// resolver of this server (client-core DnsPolicy.ruleFor), not fixed values.
async function installPeerDnsRule() {
	const rule = DnsPolicy.ruleFor({
		internalDns: store.get('tunnel.internalDns'),
		wgConfig: await wgService.readConfig(WG_CONFIG_FILE),
	});
	if (rule) await dnsPolicy.add(rule.namespace, rule.nameServer);
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

		showNotification(t('notify.disconnected'), t('notify.disconnected'), { collapseKey: 'tunnel' });
		log.info('Tunnel getrennt');

	} catch (err) {
		log.error('Fehler beim Trennen:', err);
	}
}

// ── Client-Richtlinie ────────────────────────────────────────
function policyLocks() {
	return clientPolicyUtil.locks(clientPolicy ? clientPolicy.getPolicy() : null);
}

function setAutostart(enabled) {
	if (e2e) return;
	app.setLoginItemSettings({
		openAtLogin: enabled,
		path: process.execPath,
		args: ['--minimized'],
	});
}

/**
 * Apply the (cached or freshly fetched) client policy: force the store
 * values and act on what changed. Runs at start-up with the cached policy
 * (offline-safe) and on every policy change.
 */
async function applyClientPolicy({ startup = false } = {}) {
	if (!clientPolicy) return;
	const policy = clientPolicy.getPolicy();
	const changed = applyPolicyToStore(store, policy, log);
	if (Object.keys(changed).length) log.info(`Client policy applied: ${JSON.stringify(changed)}`);

	if (changed['tunnel.killSwitch'] === true && tunnelState.connected && !killSwitch.enabled) {
		try { await killSwitch.enable(WG_CONFIG_FILE); } catch (err) { log.error('Kill-switch (policy) failed:', err.message); }
	}
	if (Object.prototype.hasOwnProperty.call(changed, 'app.startWithWindows')) {
		try { setAutostart(changed['app.startWithWindows']); } catch (err) { log.warn('Autostart (policy) failed:', err.message); }
	}
	if (!startup) {
		const hasServer = store.get('server.url', '') !== '';
		if (Object.prototype.hasOwnProperty.call(changed, 'tunnel.splitTunnel') && tunnelState.connected && !isReconnecting) {
			await disconnectTunnel();
			await connectTunnel();
		} else if (policy.autoConnect !== 'user' && hasServer && !tunnelState.connected && !isReconnecting) {
			connectTunnel().catch(() => {});
		}
	}
	broadcastState(tunnelState.connected ? 'connected' : 'disconnected');
	updateTray(tunnelState.connected ? 'connected' : 'disconnected');
	mainWindow?.webContents.send('policy:changed', clientPolicy.getState());
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

			showNotification(t('notify.reconnected'), t('notify.reconnected'), { collapseKey: 'tunnel' });
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
	showNotification(t('notify.connectionError'), t('notify.reconnectFailed'), { collapseKey: 'tunnel', force: true });
}

// ── Notifications ────────────────────────────────────────────
// The app's own notifications go through the notification center: same toast
// code as push messages, respects "Nicht stören" and "Windows-Benachrichtigung
// anzeigen" unless opts.force (messages the user must see).
function showNotification(title, body, { priority = 'normal', collapseKey = null, force = false, onClick = null, actions = null } = {}) {
	if (!notifications) {
		// Before the services exist (should not happen) fall back to a plain toast.
		if (Notification.isSupported()) new Notification({ title: `GateControl: ${title}`, body }).show();
		return null;
	}
	return notifications.notify({ title: `GateControl: ${title}`, body, priority, collapseKey, force, onClick, actions });
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
		notifyUpdate(release);
	}
	mainWindow?.webContents.send('update-ready', {
		version: release.version,
		releaseNotes: release.releaseNotes,
		mandatory: release.mandatory === true,
		channel: release.channel || null,
		minVersion: release.minVersion || null,
	});
}

// Toast of a ready update. A click on it (or "Jetzt installieren") runs the
// same install as the tray entry; the notification center keeps the
// Notification referenced, so the click still arrives later.
// (showNotification() puts "GateControl: " in front of the title.)
function notifyUpdate(info) {
	const o = updateToast(info, { t, install: () => installUpdateFromToast(), productName: 'GateControl' });
	showNotification(info.mandatory ? t('update.required') : t('update.title'), o.body, o);
}

// "Update erforderlich" notification, once per version and app session.
function notifyMandatoryUpdate(info) {
	if (!info?.version || mandatoryNotifiedVersion === info.version) return;
	mandatoryNotifiedVersion = info.version;
	notifyUpdate({ ...info, mandatory: true });
}

// Installs the update the updater has downloaded and verified (only the
// updater's verified state counts: a manual check may leave the cached
// release info unset or without an installer path).
// Core utils/update-install.js: the installer is re-hashed BEFORE the tunnel
// goes down (failure → the VPN stays), then the tunnel is disconnected and
// the kill switch lifted (the user's kill-switch preference stays, the new
// version re-enables it on connect), then the installer starts and is
// watched for a moment; a failed start reconnects the tunnel and returns the
// reason ({ ok:false, code, message, vpnRestored }) for the update card.
// Only a running installer ends the app.
let runUpdateInstall = null;
async function installUpdate() {
	if (!runUpdateInstall) {
		runUpdateInstall = createUpdateInstaller({
			getUpdater: () => updater,
			log,
			isConnected: () => tunnelState.connected,
			disconnect: () => disconnectTunnel(),
			reconnect: async () => {
				await connectTunnel();
				if (!tunnelState.connected) throw new Error('Tunnel nicht verbunden');
			},
			liftFirewall: async () => {
				if (killSwitch?.enabled) await killSwitch.disable();
			},
			quit: () => quitApp(),
			// Not downloaded / verified yet: it is fetched first — say so.
			onStatus: (state, info) => {
				if (state !== 'downloading') return;
				showNotification(t('update.title'), t('update.downloading', { version: info.version || '' }), { collapseKey: 'update', force: true });
			},
		});
	}
	return runUpdateInstall();
}

// Tray entry: no window shows the result, a failure becomes a notification.
function installUpdateFromTray({ ignoreBusy = false } = {}) {
	installUpdate().then((result) => {
		if (ignoreBusy && result?.code === 'busy') return;
		const text = installErrorText(result, t);
		if (!text) return;
		showNotification(t('update.installFailed'), text, { collapseKey: 'update', force: true, onClick: () => showWindow() });
	}).catch((err) => log.error('Update-Installation fehlgeschlagen:', err.message));
}

// Update toast (click / button): same as the tray; a second click while it
// runs (e.g. still downloading) is no error.
function installUpdateFromToast() {
	log.info('Update-Toast angeklickt – starte Installation');
	installUpdateFromTray({ ignoreBusy: true });
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
	// Push stream follows the tunnel (path "via", mode vpn_only); only an
	// up/down change reconnects it, not the stats broadcasts.
	notifications?.tunnelChanged(tunnelState.connected);
}

// ── Config check (config/check) ──────────────────────────────
// New WireGuard config from the server: validate (fail-closed), write, and
// reconnect while the tunnel is up. Polled every app.configPollInterval,
// every 30 min while the push stream delivers config_changed (core
// PushControl.relaxedInterval), and right away on config_changed.
function checkConfigNow() {
	if (configCheck) return configCheck;
	configCheck = (async () => {
		try {
			const newConfig = await apiClient.checkConfigUpdate();
			if (!newConfig) return;
			// Validate before applying — fail-closed via shared validator.
			const validation = validateWgConfig(newConfig);
			if (!validation.ok) {
				log.warn('Config update rejected: ' + validation.errors.join(', '));
				return;
			}
			if (validation.warnings && validation.warnings.length > 0) {
				log.warn('Config update warnings: ' + validation.warnings.join(', '));
			}
			log.info('Neue Konfiguration vom Server erhalten');
			await wgService.writeConfig(WG_CONFIG_FILE, newConfig);
			if (tunnelState.connected) {
				await disconnectTunnel();
				await connectTunnel();
			}
		} catch (err) {
			log.debug('Config-Poll fehlgeschlagen:', err.message);
		}
	})().finally(() => { configCheck = null; });
	return configCheck;
}

function scheduleConfigPoll() {
	if (configPollTimer) clearTimeout(configPollTimer);
	const normal = store.get('app.configPollInterval', 300) * 1000;
	const control = notifications?.pushControl;
	const ms = control ? control.relaxedInterval('config', normal) : normal;
	configPollTimer = setTimeout(() => {
		checkConfigNow().finally(() => scheduleConfigPoll());
	}, ms);
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

	// Client policies from the server (kill switch / auto-connect / autostart /
	// split modes / settings + server lock), cached for offline use.
	clientPolicy = new ClientPolicyService({
		apiClient, store, log,
		interval: store.get('app.configPollInterval', 300) * 1000,
	});
	apiClient.onPolicyVersion = (v) => { clientPolicy.noteVersion(v); };
	clientPolicy.onChange(() => { applyClientPolicy().catch((err) => log.warn('Client policy apply failed:', err.message)); });

	// Notification center: one push client + center for the app's lifetime
	// (apiClient.configure() changes URL/token in place, a server:setup resets
	// the center through the core IPC handlers).
	notifications = setupNotifications({
		app, store, log, apiClient,
		PushClient, NotificationCenter, notifyMenuItems,
		protocol: 'gatecontrol-community',
		toastImagePath: path.join(RESOURCES_PATH, 'icons', 'app-icon.png'),
		showWindow: () => showWindow(),
		openPortal: (portalPath) => openPortalSafe(portalPath),
		isTunnelUp: () => tunnelState.connected,
		isKillSwitchActive: () => !!(killSwitch?.enabled || store.get('tunnel.killSwitch', false)),
		getWgConfigPath: () => WG_CONFIG_FILE,
		// E2E runs must not register a URL handler on the test machine.
		registerProtocol: !e2e,
		onChange: () => updateTray(trayState),
	});

	// Chats: messenger on the same push stream, chat toasts with reply field.
	chats = setupMessenger({
		store, log, apiClient, notifications,
		MessengerService, ChatNotifier,
		protocol: 'gatecontrol-community',
		toastImagePath: path.join(RESOURCES_PATH, 'icons', 'app-icon.png'),
		dataDir: app.getPath('userData'),
		tmpDir: app.getPath('temp'),
		showWindow: () => showWindow(),
		getMainWindow: () => mainWindow,
		onChange: () => updateTray(trayState),
	});

	// Schule: shown while the server lists the plugin; its toasts open the page.
	school = SchoolService ? new SchoolService({
		apiClient, log,
		notificationCenter: notifications?.notificationCenter,
		pushClient: notifications?.pushClient,
	}) : null;

	// Vault: shown while the server lists the plugin. Keys and decrypted entries
	// stay in this process while unlocked; the offline copy is ciphertext only;
	// "Angemeldet bleiben" keeps the user key under DPAPI (safeStorage);
	// "Mit Windows Hello entsperren" wraps it under a Windows Hello signature
	// (core services/windows-hello.js, WinRT via koffi; core docs/vault.md).
	vault = VaultService ? new VaultService({
		apiClient,
		dir: path.join(app.getPath('userData'), 'vault'),
		protect: VaultService.safeStorageProtect(safeStorage),
		clipboard,
		notificationCenter: notifications?.notificationCenter,
		pushClient: notifications?.pushClient,
		powerMonitor,
		hello: windowsHello ? windowsHello.createWindowsHello({ log }) : null,
		helloName: 'GateControl Community Vault',
		log,
	}) : null;
	vaultQuick = vault && setupVaultQuick ? setupVaultQuick({
		BrowserWindow, globalShortcut, screen, ipcMain, vault, log,
		preload: path.join(__dirname, 'vault-quick-preload.js'),
		html: path.join(__dirname, '..', 'renderer', 'vault-quick.html'),
		getTheme: () => resolvedAppTheme(),
		getLocale: () => getLocale(),
		isMainVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
	}) : null;
	// E2E runs open the quick search without the global shortcut.
	if (e2e) e2e.vaultQuick = vaultQuick;

	// GateDrop: shown while the server lists the plugin; receives into
	// Downloads\GateControl, listens on TCP 47731 in private networks.
	gatedrop = GateDropService && setupGateDrop ? setupGateDrop({
		app, store, log, apiClient, notifications,
		GateDropService, gatedropShell,
		// Windows Firewall check / repair of the inbound rule (not in e2e runs:
		// they must not touch the firewall of the test machine).
		GateDropFirewall: e2e ? null : GateDropFirewall,
		edition: 'community',
		shell, clipboard, dialog, t,
		protocol: 'gatecontrol-community',
		toastImagePath: path.join(RESOURCES_PATH, 'icons', 'app-icon.png'),
		showWindow: () => showWindow(),
		getMainWindow: () => mainWindow,
		// E2E runs must not touch the SendTo folder of the test machine.
		manageShortcut: !e2e,
		onChange: () => updateTray(trayState),
	}) : null;

	// Last known policy first (works offline)
	await applyClientPolicy({ startup: true });

	connectionMonitor = new ConnectionMonitor({
		interval: store.get('app.checkInterval', 30) * 1000,
		apiClient,
		onDisconnect: handleDisconnect,
		onPeerDisabled: async (peerInfo) => {
			log.warn(`Peer disabled on server (id: ${peerInfo?.id}, name: ${peerInfo?.name}) — disconnecting`);
			await disconnectTunnel();
			showNotification(t('notify.disconnected'), t('notify.peerDisabled'), { collapseKey: 'tunnel', force: true });
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
		// Admin asked for a support bundle → ask the user (core sender).
		onSupportBundleRequest: (request) => supportBundle?.onServerRequest(request),
		wgService,
		log,
	});

	// Control events of the push stream (core PushControl): policy changes,
	// support-bundle requests, peer disabled and config changes arrive by push;
	// the policy, peer-info and config polls stay as the fallback (stretched
	// to 30 / 15 / 30 min while the stream delivers them).
	notifications.attachControl({
		PushControl,
		clientPolicy,
		connectionMonitor,
		onConfigChanged: () => checkConfigNow(),
		onModeChange: () => { if (configPollTimer) scheduleConfigPoll(); },
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
	const ipcCtx = {
		app,
		dialog,
		getMainWindow: () => mainWindow,
		store,
		wgService,
		apiClient,
		killSwitch,
		clientPolicy,
		getUpdater: () => updater,
		log,
		connectTunnel,
		disconnectTunnel,
		toggleKillSwitch,
		toggleRdpAllow,
		installUpdate,
		// portal:open, optionally { next: '/portal#<tab>' } (validated by core)
		openPortal: (opts) => openPortalSafe(opts),
		getTunnelState: () => tunnelState,
		wgConfigFile: WG_CONFIG_FILE,
		edition: 'community',
		// notify:* channels + events, reset on server:setup (core, opt-in)
		notificationCenter: notifications?.notificationCenter,
		// chat:* channels + events, reset on server:setup (core, opt-in)
		messenger: chats?.messenger,
		chatNotifier: chats?.chatNotifier,
		// school:* channels + events, reset on server:setup (core, opt-in)
		school,
		// vault:* channels + events, reset on server:setup (core, opt-in)
		vault,
		// gatedrop:* channels + events, reset on server:setup (core, opt-in)
		gatedrop: gatedrop?.service,
		gatedropExplorer: gatedrop?.explorer,
		// Result of a bundle the admin requested (the button shows its own status).
		onSupportResult: (res) => {
			if (!res || res.cancelled) return;
			showNotification(t('support.title'), res.success ? t('support.success') : res.error, { force: true });
		},
	};
	// One sender for the Settings button and admin requests (connection monitor).
	// The bundle carries the short device ID (client.deviceId) for the admin.
	supportBundle = createSupportBundleSender(ipcCtx, {
		collect: withDeviceId(collectSupportBundle, () => shortDeviceId(getMachineFingerprint, log)),
	});
	registerBaseHandlers(ipcMain, { ...ipcCtx, supportBundle });

	// Geräte-ID für Einstellungen → Über: nur die Kurzform (erste 8 Hex des
	// Machine-Fingerprints, wie auf der Benutzer-Seite des Servers), nie der
	// volle Wert. null = nicht verfügbar.
	ipcMain.handle('app:device-id', () => shortDeviceId(getMachineFingerprint, log));

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

	// Push stream (no-op while switched off or without a server).
	notifications.start();
	// Started by a toast button while the app was not running: the URL is in
	// argv; its one-time token is unknown to this process, so the inbox opens.
	if (notifications.handleArgv(process.argv)) log.info('Started from a notification');
	// Chats: availability check, live events, chat toasts.
	chats.start();
	// Schule: availability check, push → page.
	school?.start();
	// Vault: availability, sync, auto-lock; Strg+Alt+P while the server offers it.
	vault?.start();
	vaultQuick?.start();
	// GateDrop: availability, presence, LAN listener; started by
	// "Senden an → GateDrop" → the send dialog opens once the window is ready.
	gatedrop?.start();
	if (gatedrop?.handleArgv(process.argv)) log.info('Started from "Senden an → GateDrop"');

	// Ask the server for the current client policy (also polled, and on
	// every heartbeat/permissions answer with a new policyVersion).
	clientPolicy.start();

	// Always-on policy: bring the tunnel back when it is down (e.g. after the
	// reconnect loop gave up). Checked once a minute.
	let alwaysOnAttempt = null;
	setInterval(() => {
		if (clientPolicy.getPolicy().autoConnect !== 'always_on') return;
		if (tunnelState.connected || isReconnecting || alwaysOnAttempt) return;
		if (!store.get('server.url', '')) return;
		log.info('Always-on policy: tunnel is down, reconnecting');
		alwaysOnAttempt = connectTunnel().catch(() => {}).finally(() => { alwaysOnAttempt = null; });
	}, 60 * 1000).unref?.();

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

	// Config-Polling (fallback; config_changed by push checks right away)
	if (store.get('server.url', '')) scheduleConfigPoll();

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
	} else if (clientPolicy.getPolicy().autostart === 'forbidden') {
		setAutostart(false);
	}

	log.info('GateControl Client bereit');
});

// A second start (shortcut, autostart, or a toast button: <protocol>://notify/…)
// only brings this instance to the front or performs the toast action.
app.on('second-instance', (_event, argv) => {
	// "Senden an → GateDrop" (Explorer): open the send dialog with the files.
	if (gatedrop?.handleArgv(argv)) return;
	if (notifications?.handleArgv(argv)) return;
	showWindow();
});

app.on('window-all-closed', (e) => {
	e.preventDefault();
});

async function quitApp() {
	app.isQuitting = true;

	updater?.stop();

	// Close the push stream (flushes pending delivery confirmations).
	notifications?.stop();
	// Chats: save the cache, leave the open chat.
	chats?.stop();
	school?.stop();
	// Vault: forget the keys, stop timers, release Strg+Alt+P.
	vaultQuick?.stop();
	vault?.lock('quit');
	vault?.stop();
	// GateDrop: LAN listener and timers.
	gatedrop?.stop();

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
	// Quit without quitApp() (e.g. Windows shutdown): close the push stream too.
	notifications?.stop();
	chats?.stop();
	school?.stop();
	vaultQuick?.stop();
	vault?.lock('quit');
	vault?.stop();
	gatedrop?.stop();
});
