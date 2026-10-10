/**
 * GateControl Client – Renderer
 * UI-Logik und State Management
 */

const { tunnel, server, config, killSwitch, rdpAllow, autostart, logs, update, services, traffic, dns, shell, peer, permissions, onPortalUrl, portal, getVersion, getDeviceId, window: win, locale, policy: clientPolicy } = window.gatecontrol;
const { t } = window.gatecontrol.i18n;

// Aktive Berechtigungen (werden beim Connect geladen)
let activePermissions = { services: true, traffic: true, dns: true };

// Portal URL (pushed from main on connect/disconnect)
let currentPortalUrl = null;
// Auto-update: ready update, "later" clicked, server policy (channel /
// minimum version / mandatory, assigned by the server, read-only here).
let pendingUpdate = null;
let updateCardHidden = false;
let updatePolicy = null;
// Client policy from the server (core ClientPolicyService state):
// { fetched, managed, policy, locks, splitModes }. Unmanaged until loaded.
let policyState = { fetched: false, managed: false, policy: null, locks: {}, splitModes: ['off', 'include'] };

// ── DOM-Elemente ─────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const el = {
	// Status
	hero:         $('#hero'),
	statusLabel:  $('#status-label'),
	heroSub:      $('#hero-sub'),
	heroError:    $('#hero-error'),
	heroProgress: $('#hero-progress'),
	heroTip:      $('#hero-tip'),
	heroLogBtn:   $('#hero-log-btn'),
	connectBtn:   $('#connect-btn'),
	portalBtn:    $('#portal-btn'),
	statEndpoint: $('#stat-endpoint'),
	statHandshake: $('#stat-handshake'),
	statUptime:   $('#stat-uptime'),
	statRx:       $('#stat-rx'),
	statTx:       $('#stat-tx'),
	statRxSpeed:  $('#stat-rx-speed'),
	statTxSpeed:  $('#stat-tx-speed'),
	killswitchToggle: $('#killswitch-toggle'),
	killswitchQuick:  $('#killswitch-quick'),
	ksChip:       $('#ks-chip'),
	routingBtn:   $('#routing-btn'),
	rdpAllowToggle: $('#rdp-allow-toggle'),

	// Seitenleiste & Statusleiste
	sideDot:      $('#side-dot'),
	sideLabel:    $('#side-conn-label'),
	sideSub:      $('#side-conn-sub'),
	sideToggle:   $('#side-conn-toggle'),
	sideServer:   $('#side-server'),
	sbDot:        $('#sb-dot'),
	sbLabel:      $('#sb-label'),
	sbEndpoint:   $('#sb-endpoint'),
	sbKs:         $('#sb-ks'),
	sbRate:       $('#sb-rate'),
	overviewSub:  $('#overview-sub'),

	// Settings
	serverUrl:    $('#server-url'),
	apiKey:       $('#api-key'),
	serverStatus: $('#server-status'),
	optAutostart: $('#opt-autostart'),
	optMinimized: $('#opt-minimized'),
	optAutoconnect: $('#opt-autoconnect'),
	optCheckInterval: $('#opt-check-interval'),
	optPollInterval:  $('#opt-poll-interval'),
	optSplitTunnel: $('#opt-split-tunnel'),
	optSplitRoutes: $('#opt-split-routes'),
	splitRoutesSection: $('#split-routes-section'),

	// Logs
	logOutput:    $('#log-output'),
	logEmpty:     $('#log-empty'),
	logCount:     $('#log-count'),
	logSearch:    $('#log-search'),
};

// ── State ────────────────────────────────────────────────
let state = {
	status: 'disconnected',
	connected: false,
};

// Gespeicherte Werte, die mehrere Ansichten brauchen
const view = {
	serverUrl: '',
	splitTunnel: false,
	splitRoutes: '',
	autoConnect: true,
	dnsState: 'idle', // idle | busy | pass | fail | error
	dnsServers: [],
	servicesList: [],
	trafficData: null,
	usagePeriod: 'last7d',
	logLines: [],
	version: '',
	deviceId: undefined, // kurze Geräte-ID; null = nicht verfügbar
};

// ── Version ──────────────────────────────────────────────
getVersion().then(v => {
	view.version = v;
	const vEl = document.getElementById('app-version');
	if (vEl) vEl.textContent = `v${v}`;
	renderAboutVersion();
});

// ── Geräte-ID ────────────────────────────────────────────
// Nur die Kurzform (erste 8 Hex des Machine-Fingerprints), wie auf der
// Benutzer-Seite des Servers („Gerätebindung“). null = nicht verfügbar.
Promise.resolve()
	.then(() => getDeviceId())
	.then(id => { view.deviceId = typeof id === 'string' && /^[0-9a-f]{8}$/.test(id) ? id : null; })
	.catch(() => { view.deviceId = null; })
	.then(() => renderAboutVersion());

function renderAboutVersion() {
	const about = $('#about-version');
	if (about && view.version) about.textContent = t('ui.settings.version', { version: view.version });
	const idEl = $('#about-device-id');
	if (idEl && view.deviceId !== undefined) {
		idEl.textContent = t('ui.settings.deviceId', { id: view.deviceId ? `${view.deviceId}…` : t('ui.settings.deviceIdUnavailable') });
	}
}

// ── Theme ────────────────────────────────────────────────
// Gespeicherte Werte: 'dark' | 'light' | 'system' (System folgt prefers-color-scheme)
let themeMode = 'dark';
const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolveTheme(mode) {
	if (mode === 'system') return systemDark && !systemDark.matches ? 'light' : 'dark';
	return mode === 'light' ? 'light' : 'dark';
}

function applyTheme(mode) {
	themeMode = ['dark', 'light', 'system'].includes(mode) ? mode : 'dark';
	const resolved = resolveTheme(themeMode);
	document.documentElement.setAttribute('data-theme', resolved);
	document.querySelectorAll('.theme-btn').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.theme === themeMode);
		btn.setAttribute('aria-pressed', btn.dataset.theme === themeMode ? 'true' : 'false');
	});
	const themeBtn = $('#btn-theme');
	if (themeBtn) {
		const label = t(resolved === 'light' ? 'ui.titlebar.themeDark' : 'ui.titlebar.themeLight');
		themeBtn.title = label;
		themeBtn.setAttribute('aria-label', label);
	}
	redrawBandwidthGraph();
}

systemDark?.addEventListener?.('change', () => {
	if (themeMode === 'system') applyTheme('system');
});

config.get('app.theme').then(theme => {
	applyTheme(theme || 'dark');
});

$('#btn-theme').addEventListener('click', () => {
	const next = resolveTheme(themeMode) === 'light' ? 'dark' : 'light';
	applyTheme(next);
	config.set('app.theme', next);
});

// ── Navigation ───────────────────────────────────────────
$$('.nav-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		const page = btn.dataset.page;
		navigateTo(page);
	});
});

function navigateTo(page) {
	if (!$(`#page-${page}`)) page = 'status';
	$$('.nav-btn').forEach(b => {
		const on = b.dataset.page === page;
		b.classList.toggle('active', on);
		if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
	});

	$$('.page').forEach(p => p.classList.remove('active'));
	$(`#page-${page}`)?.classList.add('active');
	$('#pages').scrollTop = 0;

	// Logs laden wenn Tab gewechselt
	if (page === 'logs') refreshLogs();
	if (page === 'status') redrawBandwidthGraph();
}

// Navigation aus dem Main Process
window.gatecontrol.onNavigate((page) => navigateTo(page));

$('#services-all-btn').addEventListener('click', () => navigateTo('services'));
el.heroLogBtn.addEventListener('click', () => navigateTo('logs'));
el.routingBtn.addEventListener('click', () => {
	navigateTo('settings');
	selectSettingsTab('split');
});

// Einstellungs-Unterseiten
$$('.set-tab').forEach(btn => {
	btn.addEventListener('click', () => selectSettingsTab(btn.dataset.tab));
});

function selectSettingsTab(tab) {
	$$('.set-tab').forEach(b => {
		const on = b.dataset.tab === tab;
		b.classList.toggle('on', on);
		if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
	});
	$$('.set-panel').forEach(p => p.classList.toggle('active', p.id === `set-${tab}`));
	const body = $('.settings-body');
	if (body) body.scrollTop = 0;
}

// ── i18n / DOM Update ────────────────────────────────────
function updateDOM() {
	document.querySelectorAll('[data-i18n]').forEach(node => {
		node.textContent = t(node.dataset.i18n);
	});
	document.querySelectorAll('[data-i18n-placeholder]').forEach(node => {
		node.placeholder = t(node.dataset.i18nPlaceholder);
	});
	document.querySelectorAll('[data-i18n-title]').forEach(node => {
		node.title = t(node.dataset.i18nTitle);
	});
	document.querySelectorAll('[data-i18n-aria]').forEach(node => {
		node.setAttribute('aria-label', t(node.dataset.i18nAria));
	});
	document.documentElement.lang = window.gatecontrol.i18n.getLocale();
	applyTheme(themeMode);
	renderAboutVersion();
	renderDns();
	renderRouting();
	renderServices();
	renderTraffic();
	renderLogs();
	renderUpdateCard();
}

// Locale Init
locale.get().then(loc => {
	locale.set(loc);
	const selectEl = document.querySelector('#locale-select');
	if (selectEl) selectEl.value = loc;
	updateDOM();
	updateUI();
});

locale.onChange((loc) => {
	const selectEl = document.querySelector('#locale-select');
	if (selectEl) selectEl.value = loc;
	updateDOM();
	updateUI();
	applyPolicyUi();
});

const localeSelect = document.querySelector('#locale-select');
if (localeSelect) {
	localeSelect.addEventListener('change', (e) => {
		locale.set(e.target.value);
	});
}

// ── Titlebar ─────────────────────────────────────────────
$('#btn-minimize').addEventListener('click', () => win.minimize());
$('#btn-maximize').addEventListener('click', () => win.toggleMaximize?.());
$('#btn-close').addEventListener('click', () => win.close());

// ── Tunnel State Updates ─────────────────────────────────
tunnel.onState((newState) => {
	state = { ...state, ...newState };
	if (isConnected() && activePermissions.traffic) {
		pushBandwidthSample(state.rxSpeed || 0, state.txSpeed || 0);
	} else if (!isConnected()) {
		resetBandwidthGraph();
	}
	updateUI();
});

// Initial Status laden
tunnel.getStatus().then(async (s) => {
	if (s) {
		state = { ...state, ...s };
		updateUI();
		if (s.connected) {
			await loadPermissions();
			applyPermissions();
		}
	}
});

function isConnected() {
	return !!(state.connected || state.status === 'connected');
}

function uiState() {
	if (isConnected()) return 'on';
	if (state.status === 'connecting' || state.status === 'reconnecting') return 'connecting';
	if (state.status === 'error') return 'error';
	return 'off';
}

// ── UI Update ────────────────────────────────────────────
const STATE_COLORS = { on: 'var(--acc)', off: 'var(--faint)', connecting: 'var(--warn)', error: 'var(--err)' };
const STATE_HALOS = { on: 'var(--acc-bg)', off: 'transparent', connecting: 'var(--warn-bg)', error: 'var(--err-bg)' };

function updateUI() {
	const { status, endpoint, handshake, rxBytes, txBytes, rxSpeed, txSpeed, killSwitch: ks } = state;
	const ui = uiState();
	const connected = ui === 'on';
	const host = hostOf(view.serverUrl) || hostOf(endpoint) || '';

	// Hero
	el.hero.dataset.state = ui;
	const btnText = el.connectBtn.querySelector('.connect-btn-text');
	el.connectBtn.classList.toggle('connected', connected);
	el.connectBtn.classList.toggle('connecting', ui === 'connecting');
	el.heroProgress.hidden = ui !== 'connecting';
	el.heroLogBtn.hidden = ui !== 'error';
	el.heroTip.hidden = !(ui === 'off' && !view.autoConnect);
	el.heroError.hidden = ui !== 'error' || !state.error;

	if (ui === 'on') {
		el.statusLabel.textContent = t('ui.hero.on');
		el.heroSub.textContent = host ? t('ui.hero.subOn', { host }) : t('ui.hero.subOnNoHost');
		btnText.textContent = t('action.disconnect');
	} else if (ui === 'connecting') {
		el.statusLabel.textContent = status === 'reconnecting' ? t('status.reconnecting') : t('status.connecting');
		el.heroSub.textContent = t('ui.hero.subConnecting');
	} else if (ui === 'error') {
		el.statusLabel.textContent = t('ui.hero.error');
		el.heroSub.textContent = t('ui.hero.subError');
		btnText.textContent = t('ui.hero.retry');
		el.heroError.textContent = '';
		if (state.error) {
			const strong = document.createElement('strong');
			strong.textContent = t('notify.connectionError') + '. ';
			el.heroError.appendChild(strong);
			el.heroError.appendChild(document.createTextNode(String(state.error)));
		}
	} else {
		el.statusLabel.textContent = t('ui.hero.off');
		el.heroSub.textContent = ks ? t('ui.hero.subOffKs') : t('ui.hero.subOff');
		btnText.textContent = t('action.connect');
	}

	// Seitenleiste
	const label = ui === 'on' ? t('status.connected')
		: ui === 'connecting' ? (status === 'reconnecting' ? t('status.reconnecting') : t('status.connecting'))
		: ui === 'error' ? t('ui.conn.error')
		: t('status.disconnected');
	el.sideLabel.textContent = label;
	el.sideDot.style.background = STATE_COLORS[ui];
	el.sideDot.style.boxShadow = `0 0 0 4px ${STATE_HALOS[ui]}`;
	el.sideDot.classList.toggle('pulse', ui === 'connecting');
	el.sideToggle.classList.toggle('on', ui === 'on');
	el.sideToggle.classList.toggle('busy', ui === 'connecting');
	el.sideToggle.setAttribute('aria-pressed', ui === 'on' ? 'true' : 'false');
	// Always-on policy: no manual disconnect
	const disconnectLocked = !!policyState.locks.disconnect && ui === 'on';
	el.sideToggle.disabled = ui === 'connecting' || disconnectLocked;
	el.connectBtn.disabled = disconnectLocked;
	el.connectBtn.title = disconnectLocked ? t('policy.disconnectLocked') : '';
	el.sideToggle.title = disconnectLocked ? t('policy.disconnectLocked') : '';
	updateSideSub();

	// Stats
	el.statEndpoint.textContent = endpoint || '—';
	el.statHandshake.textContent = handshake || '—';
	el.statRx.textContent = formatBytes(rxBytes || 0);
	el.statTx.textContent = formatBytes(txBytes || 0);
	updateUptime();

	// Speed + Graph (nur wenn traffic-Berechtigung)
	const showRates = connected && activePermissions.traffic;
	el.statRxSpeed.textContent = showRates ? (formatSpeed(rxSpeed || 0) || '0 B/s') : '—';
	el.statTxSpeed.textContent = showRates ? (formatSpeed(txSpeed || 0) || '0 B/s') : '—';

	// Durchsatz-Karte: nur mit traffic-Berechtigung; Platzhalter solange nicht verbunden
	const bwSection = $('#bandwidth-section');
	if (bwSection) bwSection.hidden = connected && !activePermissions.traffic;
	$('#bandwidth-chart').hidden = !showRates;
	$('#bandwidth-empty').hidden = showRates;
	if (showRates) redrawBandwidthGraph();

	// Kill-Switch
	el.killswitchToggle.checked = ks || false;
	el.killswitchQuick.checked = ks || false;
	el.ksChip.className = `chip chip-icon ${ks ? 'c-ok' : 'c-warn'}`;

	// RDP Allow
	el.rdpAllowToggle.checked = state.rdpAllow || false;

	// Statusleiste
	el.sbDot.style.background = STATE_COLORS[ui];
	el.sbLabel.textContent = label;
	el.sbEndpoint.textContent = connected ? host : '';
	el.sbKs.textContent = ks ? t('ui.statusbar.ksOn') : t('ui.statusbar.ksOff');
	el.sbRate.textContent = showRates
		? `↓ ${formatSpeed(rxSpeed || 0) || '0 B/s'}  ↑ ${formatSpeed(txSpeed || 0) || '0 B/s'}`
		: '';

	// Dienste: nur mit aktivem Tunnel öffnen
	renderServices();

	// Portal button visibility
	togglePortalBtn();
}

function updateSideSub() {
	const ui = uiState();
	const host = hostOf(view.serverUrl) || hostOf(state.endpoint) || '';
	let sub;
	if (ui === 'on') sub = formatDuration(state.connectedSince) || host;
	else if (ui === 'error') sub = state.error || host;
	else sub = host || t('ui.conn.notConfigured');
	el.sideSub.textContent = sub || '—';
	el.sideSub.title = sub || '';
}

function updateUptime() {
	el.statUptime.textContent = isConnected() ? (formatDuration(state.connectedSince) || '—') : '—';
}

// Laufzeit sekündlich aktualisieren
setInterval(() => {
	if (!isConnected()) return;
	updateUptime();
	updateSideSub();
}, 1000);

function renderOverviewHeader() {
	const host = hostOf(view.serverUrl);
	el.overviewSub.textContent = host ? t('ui.overview.sub', { host }) : t('ui.overview.subNone');
	el.sideServer.textContent = host || '—';
	el.sideServer.title = view.serverUrl || '';
}

// ── Connect Button ───────────────────────────────────────
async function toggleConnection() {
	if (state.status === 'connecting') return;

	if (state.connected) {
		if (policyState.locks.disconnect) return;
		await tunnel.disconnect();
	} else {
		await tunnel.connect();
	}
}

el.connectBtn.addEventListener('click', toggleConnection);
el.sideToggle.addEventListener('click', toggleConnection);
$('#services-connect-btn').addEventListener('click', toggleConnection);

// ── Portal Button ────────────────────────────────────────
function togglePortalBtn() {
	const show = !!(currentPortalUrl && state.connected);
	el.portalBtn?.toggleAttribute('hidden', !show);
}

onPortalUrl?.((url) => {
	currentPortalUrl = url;
	togglePortalBtn();
});

el.portalBtn?.addEventListener('click', () => {
	// Main fetches a fresh one-time login link and falls back to the portal URL.
	if (currentPortalUrl) portal.open();
});

// ── Kill-Switch Toggle ───────────────────────────────────
function onKillSwitchChange(e) {
	const on = e.target.checked;
	state = { ...state, killSwitch: on };
	updateUI();
	killSwitch.toggle(on);
}
el.killswitchToggle.addEventListener('change', onKillSwitchChange);
el.killswitchQuick.addEventListener('change', onKillSwitchChange);

// ── RDP Allow Toggle ─────────────────────────────────────
el.rdpAllowToggle.addEventListener('change', (e) => {
	rdpAllow.toggle(e.target.checked);
});

// ── Settings: Server ─────────────────────────────────────
// Laden
config.getAll().then(cfg => {
	if (!cfg) return;
	el.serverUrl.value = cfg.server?.url || '';
	el.apiKey.value = cfg.server?.apiKey || '';
	el.optAutostart.checked = cfg.app?.startWithWindows ?? true;
	el.optMinimized.checked = cfg.app?.startMinimized ?? true;
	applyTheme(cfg.app?.theme || 'dark');
	el.optAutoconnect.checked = cfg.tunnel?.autoConnect ?? true;
	el.optCheckInterval.value = cfg.app?.checkInterval ?? 30;
	el.optPollInterval.value = cfg.app?.configPollInterval ?? 300;
	el.optSplitTunnel.checked = cfg.tunnel?.splitTunnel ?? false;
	el.optSplitRoutes.value = cfg.tunnel?.splitRoutes || '';

	view.serverUrl = cfg.server?.url || '';
	view.autoConnect = el.optAutoconnect.checked;
	view.splitTunnel = el.optSplitTunnel.checked;
	view.splitRoutes = el.optSplitRoutes.value;
	renderSplitMode();
	renderRouting();
	renderOverviewHeader();
	updateUI();
});

// API-Key anzeigen/verbergen
$('#toggle-api-key').addEventListener('click', () => {
	const input = el.apiKey;
	input.type = input.type === 'password' ? 'text' : 'password';
});

// Server testen
$('#btn-test-server').addEventListener('click', async () => {
	showServerStatus(t('server.testInProgress'), 'info');

	// Temporär URL setzen
	const url = el.serverUrl.value.trim();
	const key = el.apiKey.value.trim();

	if (!url || !key) {
		showServerStatus(t('server.urlAndKeyRequired'), 'error');
		return;
	}

	const result = await server.test({ url, apiKey: key });
	if (result.success) {
		showServerStatus(t('server.testSuccess'), 'success');
	} else {
		showServerStatus(t('server.testError', { error: result.error }), 'error');
	}
});

// Server speichern
$('#btn-save-server').addEventListener('click', async () => {
	const url = el.serverUrl.value.trim();
	const key = el.apiKey.value.trim();

	if (!url || !key) {
		showServerStatus(t('server.urlAndKeyRequired'), 'error');
		return;
	}

	showServerStatus(t('server.registering'), 'info');

	const result = await server.setup({ url, apiKey: key });
	if (result.success) {
		view.serverUrl = url;
		renderOverviewHeader();
		updateSideSub();
		showServerStatus(t(result.enrolled ? 'server.enrolled' : 'server.registered', { peerId: result.peerId }), 'success');
	} else {
		showServerStatus(t('server.testError', { error: result.error }), 'error');
	}
});

function showServerStatus(message, type) {
	el.serverStatus.hidden = false;
	el.serverStatus.textContent = message;
	el.serverStatus.className = `field-status ${type}`;

	if (type === 'success') {
		setTimeout(() => { el.serverStatus.hidden = true; }, 5000);
	}
}

// ── Settings: Config Import ──────────────────────────────
$('#btn-import-file').addEventListener('click', async () => {
	const result = await config.importFile();
	if (result.success) {
		showServerStatus(t('server.configImported', { path: result.path }), 'success');
	} else if (result.error) {
		showServerStatus(t('server.importError', { error: result.error }), 'error');
	}
});

// QR-Code Scanner
let qrStream = null;

$('#btn-import-qr').addEventListener('click', async () => {
	const preview = $('#qr-preview');
	const video = $('#qr-video');

	try {
		qrStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: 'environment' }
		});

		video.srcObject = qrStream;
		preview.hidden = false;

		// QR-Code scannen mit 60s Timeout
		scanQR();
		setTimeout(() => {
			if (qrStream) {
				stopQRScan();
				showServerStatus(t('server.qrTimeout'), 'error');
			}
		}, 60000);
	} catch (err) {
		showServerStatus(t('server.cameraError', { error: err.message }), 'error');
	}
});

$('#btn-qr-cancel').addEventListener('click', stopQRScan);

function stopQRScan() {
	if (qrStream) {
		qrStream.getTracks().forEach(track => track.stop());
		qrStream = null;
	}
	$('#qr-preview').hidden = true;
}

async function scanQR() {
	const video = $('#qr-video');
	const canvas = $('#qr-canvas');
	const ctx = canvas.getContext('2d');

	const scan = async () => {
		if (!qrStream) return;

		if (video.readyState === video.HAVE_ENOUGH_DATA) {
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			ctx.drawImage(video, 0, 0);

			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
			const result = await config.importQR({
				data: Array.from(imageData.data),
				width: canvas.width,
				height: canvas.height,
			});

			// Setup QR ("App einrichten"): core asked the user and redeemed it —
			// stop scanning either way, or the next frame would ask again.
			if (result.enrollment) {
				stopQRScan();
				if (result.success) showServerStatus(t('server.enrolled', { peerId: result.peerId }), 'success');
				else if (!result.cancelled) showServerStatus(result.error, 'error');
				return;
			}

			if (result.success) {
				stopQRScan();
				showServerStatus(t('server.qrSuccess'), 'success');
				return;
			}
		}

		requestAnimationFrame(scan);
	};

	scan();
}

// ── Settings: App Options ────────────────────────────────
el.optAutostart.addEventListener('change', (e) => {
	autostart.set(e.target.checked);
	config.set('app.startWithWindows', e.target.checked);
});

el.optMinimized.addEventListener('change', (e) => {
	config.set('app.startMinimized', e.target.checked);
});

el.optAutoconnect.addEventListener('change', (e) => {
	config.set('tunnel.autoConnect', e.target.checked);
	view.autoConnect = e.target.checked;
	updateUI();
});

el.optCheckInterval.addEventListener('change', (e) => {
	const val = Math.max(5, Math.min(300, parseInt(e.target.value, 10) || 30));
	e.target.value = val;
	config.set('app.checkInterval', val);
});

el.optPollInterval.addEventListener('change', (e) => {
	const val = Math.max(30, Math.min(3600, parseInt(e.target.value, 10) || 300));
	e.target.value = val;
	config.set('app.configPollInterval', val);
});

// ── Theme Switch ────────────────────────────────────────
document.querySelectorAll('.theme-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		const theme = btn.dataset.theme;
		applyTheme(theme);
		config.set('app.theme', theme);
	});
});

// ── Split-Tunneling ─────────────────────────────────────
function renderSplitMode() {
	const on = el.optSplitTunnel.checked;
	$$('.opt[data-split]').forEach(opt => {
		opt.setAttribute('aria-pressed', (opt.dataset.split === 'on') === on ? 'true' : 'false');
	});
	el.splitRoutesSection.hidden = !on;
	applySplitPolicy();
}

function renderRouting() {
	if (!el.routingBtn) return;
	if (view.splitTunnel) {
		const count = (view.splitRoutes || '').split('\n').filter(l => l.trim()).length;
		el.routingBtn.textContent = t('ui.protection.routingSplit', { count });
	} else {
		el.routingBtn.textContent = t('ui.protection.routingFull');
	}
}

$$('.opt[data-split]').forEach(opt => {
	opt.addEventListener('click', () => {
		const want = opt.dataset.split === 'on';
		if (el.optSplitTunnel.checked === want) return;
		el.optSplitTunnel.checked = want;
		el.optSplitTunnel.dispatchEvent(new Event('change'));
	});
});

el.optSplitTunnel.addEventListener('change', async (e) => {
	config.set('tunnel.splitTunnel', e.target.checked);
	view.splitTunnel = e.target.checked;
	renderSplitMode();
	renderRouting();

	// Wenn verbunden: Reconnect anbieten
	if (state.connected) {
		showSplitStatus(e.target.checked
			? t('split.activateOnReconnect')
			: t('split.fullTunnelOnReconnect'), 'info');
		await tunnel.reconnect();
	}
});

$('#btn-save-split').addEventListener('click', async () => {
	const routes = el.optSplitRoutes.value.trim();
	config.set('tunnel.splitRoutes', routes);
	view.splitRoutes = routes;
	renderRouting();

	if (!routes) {
		showSplitStatus(t('split.noRoutes'), 'warn');
		return;
	}

	const count = routes.split('\n').filter(l => l.trim()).length;
	showSplitStatus(t('split.routesSaved', { count }), 'info');

	// Reconnect wenn verbunden
	if (state.connected) {
		await tunnel.reconnect();
	} else {
		showSplitStatus(t('split.routesSavedPending', { count }), 'info');
	}
});

let splitStatusTimer = null;
function showSplitStatus(msg, type) {
	const node = $('#split-status');
	if (!node) return;
	node.hidden = false;
	node.textContent = msg;
	node.className = `inline-status ${type === 'warn' ? 'warn' : 'success'}`;
	clearTimeout(splitStatusTimer);
	splitStatusTimer = setTimeout(() => { node.hidden = true; }, 5000);
}

// ── Logs ─────────────────────────────────────────────────
let logPeriod = 'all';
let logLevel = 'all';

const LOG_LINE = /^\[([^\]]+)\]\s*\[(\w+)\]\s*(.*)$/;
const LOG_LEVELS = {
	error: { key: 'ui.logs.levelError', cls: 'c-err', group: 'error' },
	warn: { key: 'ui.logs.levelWarn', cls: 'c-warn', group: 'warn' },
	info: { key: 'ui.logs.levelInfo', cls: 'c-info', group: 'info' },
};

function parseLogLine(line) {
	const m = line.match(LOG_LINE);
	if (!m) return { time: '', level: '', msg: line };
	return { time: m[1], level: m[2].toLowerCase(), msg: m[3] };
}

async function refreshLogs() {
	el.logOutput.textContent = '';
	el.logEmpty.hidden = false;
	el.logEmpty.textContent = t('logs.loading');
	el.logCount.textContent = '';
	const logText = await logs.get({ period: logPeriod });
	view.logLines = (logText || '').split('\n').filter(l => l.trim()).map(parseLogLine);
	renderLogs();
	const card = $('.log-card');
	if (card) card.scrollTop = 0; // newest on top
}

function renderLogs() {
	if (!el.logOutput || !$('#page-logs').classList.contains('active')) return;
	const query = (el.logSearch.value || '').trim().toLowerCase();
	const rows = view.logLines.filter(r => {
		if (logLevel !== 'all') {
			const group = r.level === 'warning' ? 'warn' : r.level;
			if (group !== logLevel) return false;
		}
		return !query || r.msg.toLowerCase().includes(query) || r.time.toLowerCase().includes(query);
	});

	const frag = document.createDocumentFragment();
	for (const r of rows) {
		const row = document.createElement('div');
		row.className = 'log-row';
		const time = document.createElement('span');
		time.className = 'log-time';
		time.textContent = r.time;
		const lvl = document.createElement('span');
		lvl.className = 'log-level';
		if (r.level) {
			const info = LOG_LEVELS[r.level === 'warning' ? 'warn' : r.level];
			const chip = document.createElement('span');
			chip.className = `chip ${info ? info.cls : ''}`;
			chip.textContent = info ? t(info.key) : r.level;
			lvl.appendChild(chip);
		}
		const msg = document.createElement('span');
		msg.className = 'log-msg';
		msg.textContent = r.msg;
		row.append(time, lvl, msg);
		frag.appendChild(row);
	}
	el.logOutput.textContent = '';
	el.logOutput.appendChild(frag);

	el.logCount.textContent = t('ui.logs.count', { count: rows.length });
	if (view.logLines.length === 0) {
		el.logEmpty.hidden = false;
		el.logEmpty.textContent = t('logs.empty');
	} else if (rows.length === 0) {
		el.logEmpty.hidden = false;
		el.logEmpty.textContent = t('ui.logs.noMatch');
	} else {
		el.logEmpty.hidden = true;
	}
}

$('#btn-refresh-logs').addEventListener('click', refreshLogs);
el.logSearch.addEventListener('input', renderLogs);

// Log period filter
const logPeriodFilter = $('#log-period-filter');
if (logPeriodFilter) {
	logPeriodFilter.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-period]');
		if (!btn) return;
		logPeriod = btn.dataset.period;
		logPeriodFilter.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
		refreshLogs();
	});
}

// Log level filter (clientseitig)
const logLevelFilter = $('#log-level-filter');
if (logLevelFilter) {
	logLevelFilter.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-level]');
		if (!btn) return;
		logLevel = btn.dataset.level;
		logLevelFilter.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
		renderLogs();
	});
}

// Log export
const exportLogsBtn = $('#btn-export-logs');
if (exportLogsBtn) {
	exportLogsBtn.addEventListener('click', async () => {
		// Shows the log file in Explorer (shell:open-external only takes http(s)).
		await logs.show();
	});
}

// ── Helpers ──────────────────────────────────────────────
function formatBytes(bytes) {
	if (!bytes || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const val = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
	return `${val} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
	if (bytesPerSec < 1) return '';
	if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
	if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
	return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}

function formatDuration(since) {
	if (!since) return '';
	const start = new Date(since).getTime();
	if (!Number.isFinite(start)) return '';
	const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
	const h = Math.floor(secs / 3600);
	const m = Math.floor(secs / 60) % 60;
	const s = secs % 60;
	return [h, m, s].map(x => String(x).padStart(2, '0')).join(':');
}

function hostOf(url) {
	if (!url || typeof url !== 'string') return '';
	try {
		return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host;
	} catch {
		return url;
	}
}

function cssVar(name) {
	return getComputedStyle($('#app-root')).getPropertyValue(name).trim();
}

// ── Bandwidth Graph (Canvas) ─────────────────────────────
const BW_HISTORY_LEN = 60; // 60 Datenpunkte (ein Punkt pro Statistik-Update)
const bwHistory = { rx: [], tx: [] };

function pushBandwidthSample(rxSpeed, txSpeed) {
	bwHistory.rx.push(rxSpeed);
	bwHistory.tx.push(txSpeed);
	if (bwHistory.rx.length > BW_HISTORY_LEN) bwHistory.rx.shift();
	if (bwHistory.tx.length > BW_HISTORY_LEN) bwHistory.tx.shift();
}

function resetBandwidthGraph() {
	bwHistory.rx.length = 0;
	bwHistory.tx.length = 0;
}

function redrawBandwidthGraph() {
	const canvas = document.getElementById('bandwidth-canvas');
	if (!canvas || canvas.offsetParent === null) return;

	const ctx = canvas.getContext('2d');
	const dpr = window.devicePixelRatio || 1;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (!w || !h) return;

	const newW = Math.round(w * dpr);
	const newH = Math.round(h * dpr);
	if (canvas.width !== newW || canvas.height !== newH) {
		canvas.width = newW;
		canvas.height = newH;
	}
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	const allValues = [...bwHistory.rx, ...bwHistory.tx];
	const maxVal = Math.max(...allValues, 1024); // min 1 KB/s scale
	const maxLabel = $('#chart-max');
	if (maxLabel) maxLabel.textContent = formatSpeed(maxVal);

	// Grid lines
	ctx.strokeStyle = cssVar('--line');
	ctx.lineWidth = 1;
	for (let i = 1; i < 4; i++) {
		const y = Math.round((h / 4) * i) + 0.5;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(w, y);
		ctx.stroke();
	}

	const step = w / (BW_HISTORY_LEN - 1);
	const yOf = (v) => h - (v / maxVal) * (h - 16);
	const xOf = (len, i) => (BW_HISTORY_LEN - len + i) * step;

	function drawLine(data, color, fill, dashed) {
		if (data.length < 2) return;

		if (fill) {
			ctx.beginPath();
			ctx.moveTo(xOf(data.length, 0), h);
			for (let i = 0; i < data.length; i++) ctx.lineTo(xOf(data.length, i), yOf(data[i]));
			ctx.lineTo(xOf(data.length, data.length - 1), h);
			ctx.closePath();
			ctx.fillStyle = fill;
			ctx.fill();
		}

		ctx.beginPath();
		for (let i = 0; i < data.length; i++) {
			const x = xOf(data.length, i);
			const y = yOf(data[i]);
			i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
		}
		ctx.setLineDash(dashed ? [5, 4] : []);
		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.lineJoin = 'round';
		ctx.stroke();
		ctx.setLineDash([]);
	}

	drawLine(bwHistory.rx, cssVar('--acc-t'), cssVar('--acc-bg'), false); // Download
	drawLine(bwHistory.tx, cssVar('--info'), null, true);                 // Upload
}

window.addEventListener('resize', () => redrawBandwidthGraph());

// Stats werden via IPC tunnel.onState gepusht (kein separater Poll nötig)

// ── Auto-Update UI ──────────────────────────────────────
const UPDATE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"></path></svg>';

function showUpdateBanner(info) {
	pendingUpdate = info;
	updateCardHidden = false;
	renderUpdateCard();
}

function applyUpdatePolicy(policy) {
	updatePolicy = policy || null;
	renderUpdateCard();
}

function requiredText(st) {
	return st.minVersion
		? t('update.requiredDesc', { minVersion: st.minVersion, version: st.version })
		: t('update.requiredDescNoMin', { version: st.version });
}

// Sidebar card (optional: "later" hides it; mandatory: no "later") and the
// persistent "Update erforderlich" notice on the overview (no close button).
function renderUpdateCard() {
	const st = window.GCUpdateState.updateCardState(pendingUpdate, updatePolicy, updateCardHidden);

	const existing = $('#update-banner');
	if (existing) existing.remove();
	if (st.visible) {
		const card = document.createElement('div');
		card.id = 'update-banner';
		card.className = st.mandatory ? 'card update-card mandatory' : 'card update-card';
		card.setAttribute('role', st.mandatory ? 'alert' : 'status');

		const head = document.createElement('div');
		head.className = 'update-card-head';
		head.innerHTML = UPDATE_ICON;
		const title = document.createElement('span');
		title.textContent = st.mandatory ? t('update.required') : t('update.available', { version: st.version });
		head.appendChild(title);
		card.appendChild(head);

		const text = document.createElement('p');
		text.textContent = st.mandatory ? `${requiredText(st)} ${t('update.requiredTunnelHint')}` : t('update.readyToInstall');
		card.appendChild(text);

		const actions = document.createElement('div');
		actions.className = 'update-card-actions';

		const installBtn = document.createElement('button');
		installBtn.type = 'button';
		installBtn.className = 'btn btn-sec btn-sm';
		installBtn.textContent = t('update.install');
		installBtn.addEventListener('click', () => update.install());
		actions.appendChild(installBtn);

		if (st.dismissable) {
			const laterBtn = document.createElement('button');
			laterBtn.type = 'button';
			laterBtn.className = 'btn btn-ghost btn-sm';
			laterBtn.textContent = t('update.later');
			laterBtn.addEventListener('click', () => { updateCardHidden = true; renderUpdateCard(); });
			actions.appendChild(laterBtn);
		}

		card.appendChild(actions);
		$('#update-slot').appendChild(card);
	}

	const oldNotice = $('#update-required-banner');
	if (oldNotice) oldNotice.remove();
	if (st.mandatory) {
		const notice = document.createElement('div');
		notice.id = 'update-required-banner';
		notice.className = 'notice notice-err';
		notice.setAttribute('role', 'alert');
		notice.innerHTML = UPDATE_ICON;
		const body = document.createElement('div');
		body.className = 'grow';
		const strong = document.createElement('strong');
		strong.textContent = t('update.required');
		const desc = document.createElement('div');
		desc.className = 'muted';
		desc.textContent = `${requiredText(st)} ${t('update.requiredTunnelHint')}`;
		body.appendChild(strong);
		body.appendChild(desc);
		notice.appendChild(body);
		const installBtn = document.createElement('button');
		installBtn.type = 'button';
		installBtn.id = 'update-required-install';
		installBtn.className = 'btn btn-sec';
		installBtn.textContent = t('update.install');
		installBtn.addEventListener('click', () => update.install());
		notice.appendChild(installBtn);
		$('#update-required-slot').appendChild(notice);
	}

	const channel = $('#update-channel');
	if (channel) {
		const ch = updatePolicy && updatePolicy.channel;
		channel.textContent = t(window.GCUpdateState.channelLabelKey(ch));
		channel.classList.toggle('c-warn', ch === 'beta');
	}
}

update.onReady((info) => showUpdateBanner(info));
update.onPolicy((policy) => applyUpdatePolicy(policy));
update.policy().then((policy) => applyUpdatePolicy(policy)).catch(() => {});

// Über → Nach Updates suchen
$('#btn-check-update').addEventListener('click', async () => {
	const btn = $('#btn-check-update');
	const result = $('#update-check-result');
	btn.disabled = true;
	result.textContent = t('ui.settings.checking');
	try {
		const info = await update.check();
		update.policy().then((policy) => applyUpdatePolicy(policy)).catch(() => {});
		if (info) {
			result.textContent = t('update.available', { version: info.version });
			showUpdateBanner(info);
		} else {
			result.textContent = t('update.noUpdate');
		}
	} catch {
		result.textContent = t('update.noUpdate');
	}
	btn.disabled = false;
});

// Über → Support-Paket senden: main asks for confirmation (native dialog),
// collects the redacted bundle and uploads it; cancelled → no message.
function showSupportStatus(message, type) {
	const st = $('#support-status');
	st.hidden = false;
	st.textContent = message;
	st.className = `field-status ${type}`;
	if (type === 'success') setTimeout(() => { st.hidden = true; }, 5000);
}

$('#support-send').addEventListener('click', async () => {
	const btn = $('#support-send');
	btn.disabled = true;
	$('#support-status').hidden = true;
	try {
		const res = await window.gatecontrol.support.send();
		if (res?.success) showSupportStatus(t('support.success'), 'success');
		else if (!res?.cancelled) showSupportStatus(res?.error || t('support.failed', { error: '' }), 'error');
	} catch (err) {
		showSupportStatus(t('support.failed', { error: err?.message || '' }), 'error');
	}
	btn.disabled = false;
});

// ── Peer-Ablauf-Warnung ─────────────────────────────────
peer.onExpiry((info) => {
	const existing = $('#expiry-banner');
	if (existing) existing.remove();

	const banner = document.createElement('div');
	banner.id = 'expiry-banner';
	banner.setAttribute('role', 'status');

	let msg, kind;
	if (info.daysLeft <= 0) {
		msg = t('peer.expired');
		kind = 'err';
	} else if (info.daysLeft <= 1) {
		msg = t('peer.expiresToday');
		kind = 'err';
	} else {
		msg = t('peer.expiresInDays', { days: info.daysLeft });
		kind = info.daysLeft <= 3 ? 'warn' : 'info';
	}

	banner.className = `notice notice-${kind}`;
	banner.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4M12 17h.01"></path></svg>';
	const text = document.createElement('strong');
	text.className = 'grow';
	text.textContent = msg;
	banner.appendChild(text);

	const close = document.createElement('button');
	close.type = 'button';
	close.className = 'btn btn-ghost btn-icon';
	close.style.cssText = 'width:30px;height:30px';
	close.setAttribute('aria-label', t('update.later'));
	close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>';
	close.addEventListener('click', () => banner.remove());
	banner.appendChild(close);

	$('#expiry-slot').appendChild(banner);
});
update.check().then((info) => { if (info) showUpdateBanner(info); });

// ── Erreichbare Dienste ─────────────────────────────────
async function loadPermissions() {
	try {
		const perms = await permissions.get();
		if (perms) {
			activePermissions = { ...perms, _loaded: true };
		}
	} catch {}
}

function applyPermissions() {
	const trafficSection = $('#traffic-usage');
	const dnsSection = document.querySelector('.dns-section');

	// Services
	if (activePermissions.services) {
		loadServices();
	} else {
		view.servicesList = [];
		renderServices();
	}

	// Traffic + Bandbreiten-Graph
	if (activePermissions.traffic) {
		loadTraffic();
	} else {
		view.trafficData = null;
		if (trafficSection) trafficSection.hidden = true;
	}

	// DNS-Leak-Test
	if (dnsSection) dnsSection.hidden = !activePermissions.dns;

	updateUI();
}

async function loadServices() {
	const list = await services.list();
	view.servicesList = Array.isArray(list) ? list : [];
	renderServices();
}

function serviceInitial(svc) {
	const name = String(svc.name || svc.domain || '?').trim();
	return (name[0] || '?').toUpperCase();
}

function openService(svc) {
	if (svc.url) shell.openExternal(svc.url);
}

function renderServices() {
	const list = view.servicesList || [];
	const connected = isConnected();

	// Übersicht: Schnellzugriff (max. 4)
	const section = $('#services-section');
	const quick = $('#services-list');
	if (section && quick) {
		section.hidden = list.length === 0;
		quick.textContent = '';
		list.slice(0, 4).forEach((svc) => {
			const tile = document.createElement('button');
			tile.type = 'button';
			tile.className = 'service-tile service-item';
			tile.disabled = !connected;
			tile.title = svc.url || '';
			tile.addEventListener('click', () => openService(svc));

			const initial = document.createElement('span');
			initial.className = 'service-initial';
			initial.textContent = serviceInitial(svc);

			const text = document.createElement('span');
			text.className = 'service-text';
			const name = document.createElement('span');
			name.className = 'service-name';
			name.textContent = svc.name;
			const domain = document.createElement('span');
			domain.className = 'service-domain';
			domain.textContent = svc.domain;
			text.append(name, domain);

			tile.append(initial, text);
			quick.appendChild(tile);
		});
	}

	// Dienste-Seite
	const grid = $('#services-page-list');
	if (grid) {
		grid.textContent = '';
		list.forEach((svc) => {
			const card = document.createElement('div');
			card.className = 'card service-card';

			const head = document.createElement('div');
			head.className = 'service-card-head';
			const initial = document.createElement('span');
			initial.className = 'service-initial';
			initial.textContent = serviceInitial(svc);
			const text = document.createElement('div');
			text.className = 'service-text grow';
			const name = document.createElement('div');
			name.className = 'service-name';
			name.textContent = svc.name;
			const domain = document.createElement('div');
			domain.className = 'service-domain';
			domain.textContent = svc.domain;
			text.append(name, domain);
			head.append(initial, text);

			const foot = document.createElement('div');
			foot.className = 'service-card-foot';
			if (svc.hasAuth) {
				const badge = document.createElement('span');
				badge.className = 'chip c-info service-auth';
				badge.textContent = t('ui.services.auth');
				foot.appendChild(badge);
			}
			const spacer = document.createElement('span');
			spacer.className = 'grow';
			foot.appendChild(spacer);
			const open = document.createElement('button');
			open.type = 'button';
			open.className = 'btn btn-sec btn-sm';
			open.disabled = !connected;
			open.textContent = t('ui.services.open');
			open.insertAdjacentHTML('beforeend', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>');
			open.addEventListener('click', () => openService(svc));
			foot.appendChild(open);

			card.append(head, foot);
			grid.appendChild(card);
		});
	}

	const offline = $('#services-offline');
	if (offline) offline.hidden = connected;
	const empty = $('#services-empty');
	if (empty) empty.hidden = list.length > 0 || !connected;

	const count = $('#services-count');
	if (count) {
		count.hidden = list.length === 0;
		count.textContent = String(list.length);
	}
}

// Permissions, Dienste und Traffic laden wenn verbunden
tunnel.onState(async (s) => {
	if (s.connected || s.status === 'connected') {
		if (!activePermissions._loaded) {
			await loadPermissions();
			applyPermissions();
		}
	} else {
		activePermissions._loaded = false;
	}
});

// ── Traffic-Verbrauch ───────────────────────────────────
async function loadTraffic() {
	const data = await traffic.stats();
	if (!data) return;
	view.trafficData = data;
	renderTraffic();
}

function renderTraffic() {
	const section = $('#traffic-usage');
	const data = view.trafficData;
	if (!section) return;
	if (!data) { section.hidden = true; return; }
	section.hidden = false;

	const p = data[view.usagePeriod] || {};
	const rx = p.rx || 0;
	const tx = p.tx || 0;
	const total = rx + tx;
	$('#usage-total').textContent = formatBytes(total);
	$('#usage-rx').textContent = formatBytes(rx);
	$('#usage-tx').textContent = formatBytes(tx);
	const rxPct = total > 0 ? Math.round((rx / total) * 100) : 0;
	$('#usage-bar-rx').style.width = `${rxPct}%`;
	$('#usage-bar-tx').style.width = `${total > 0 ? 100 - rxPct : 0}%`;

	$$('#usage-period [data-usage]').forEach(b => {
		const on = b.dataset.usage === view.usagePeriod;
		b.classList.toggle('on', on);
		b.setAttribute('aria-selected', on ? 'true' : 'false');
	});
}

$('#usage-period').addEventListener('click', (e) => {
	const btn = e.target.closest('[data-usage]');
	if (!btn) return;
	view.usagePeriod = btn.dataset.usage;
	renderTraffic();
});

// ── DNS-Leak-Test ───────────────────────────────────────
const dnsBtn = $('#dns-test-btn');
const dnsResult = $('#dns-result');

function renderDns() {
	const label = $('#dns-test-label');
	const text = $('#dns-text');
	if (!label || !text) return;
	const s = view.dnsState;
	label.textContent = s === 'busy' ? t('dns.testing') : t('ui.protection.dnsRun');
	dnsResult.className = `dns-result ${s}`;
	text.textContent = '';
	const servers = (view.dnsServers || []).join(', ');
	if (s === 'pass' || s === 'fail') {
		const title = document.createElement('strong');
		title.textContent = t(s === 'pass' ? 'dns.noLeak' : 'dns.leak');
		text.appendChild(title);
		text.appendChild(document.createTextNode(' · ' + t(s === 'pass' ? 'dns.noLeakDetail' : 'dns.leakDetail', { servers })));
	} else if (s === 'error') {
		dnsResult.className = 'dns-result fail';
		text.textContent = t('dns.testFailed');
	} else if (s === 'busy') {
		text.textContent = t('dns.testing');
	} else {
		text.textContent = t('ui.protection.dnsIdle');
	}
}

if (dnsBtn) {
	dnsBtn.addEventListener('click', async () => {
		dnsBtn.disabled = true;
		view.dnsState = 'busy';
		renderDns();

		try {
			const result = await dns.leakTest();
			view.dnsServers = result.dnsServers || [];
			view.dnsState = result.passed ? 'pass' : 'fail';
		} catch {
			view.dnsState = 'error';
		}

		dnsBtn.disabled = false;
		renderDns();
	});
}

renderDns();
renderRouting();
renderServices();
renderOverviewHeader();

// ══════════════════════════════════════════════════════════
//  CLIENT-RICHTLINIE (vom Server, "Vom Administrator festgelegt")
// ══════════════════════════════════════════════════════════
/** Disable a control and show/remove the "set by your administrator" hint. */
function setPolicyLock(control, locked, hintHost, hintKey = 'policy.lockedHint') {
	if (control) {
		control.disabled = !!locked;
		control.classList.toggle('policy-locked', !!locked);
	}
	if (!hintHost) return;
	let hint = hintHost.querySelector(':scope > .policy-hint');
	if (locked) {
		if (!hint) {
			hint = document.createElement('div');
			hint.className = 'policy-hint';
			hintHost.appendChild(hint);
		}
		hint.textContent = t(hintKey);
	} else if (hint) {
		hint.remove();
	}
}

const rowOf = (node) => node?.closest('.set-row')?.querySelector('.grow') || node?.closest('.field');

function applySplitPolicy() {
	const p = policyState.policy || {};
	const modes = policyState.splitModes || ['off', 'include'];
	const frozen = !!(p.lockSettings || p.splitTunnelLocked);
	const offBtn = $('.opt[data-split="off"]');
	const onBtn = $('.opt[data-split="on"]');
	if (!offBtn || !onBtn) return;
	setPolicyLock(offBtn, frozen || !modes.includes('off'), null);
	setPolicyLock(onBtn, frozen || !modes.includes('include'), null);
	const card = offBtn.closest('.set-card');
	setPolicyLock(null, frozen || modes.length < 2, card, p.splitTunnelLocked ? 'policy.splitModeLocked' : 'policy.lockedHint');
	const routesLocked = !!policyState.locks.splitRoutes;
	el.optSplitRoutes.disabled = routesLocked;
	$('#btn-save-split').disabled = routesLocked;
}

function applyPolicyUi() {
	const l = policyState.locks || {};
	const p = policyState.policy || {};
	setPolicyLock(el.killswitchToggle, l.killSwitch, rowOf(el.killswitchToggle), p.killSwitch === 'required' ? 'policy.killSwitchRequired' : 'policy.lockedHint');
	setPolicyLock(el.killswitchQuick, l.killSwitch, null);
	el.killswitchQuick.closest('label')?.setAttribute('title', l.killSwitch ? t('policy.lockedHint') : '');
	setPolicyLock(el.rdpAllowToggle, l.settings, rowOf(el.rdpAllowToggle));
	setPolicyLock(el.optAutostart, l.autostart, rowOf(el.optAutostart), p.autostart === 'forbidden' ? 'policy.autostartForbidden' : 'policy.lockedHint');
	setPolicyLock(el.optAutoconnect, l.autoConnect, rowOf(el.optAutoconnect));
	setPolicyLock(el.optMinimized, l.settings, rowOf(el.optMinimized));
	setPolicyLock(el.optCheckInterval, l.settings, rowOf(el.optCheckInterval));
	setPolicyLock(el.optPollInterval, l.settings, rowOf(el.optPollInterval));

	// Server change / config import (re-setup)
	const serverCard = el.serverUrl?.closest('section');
	const importCard = $('#btn-import-file')?.closest('section');
	if (serverCard) serverCard.hidden = !!l.server;
	if (importCard) importCard.hidden = !!l.server;
	const serverHint = $('#policy-server-hint');
	if (serverHint) {
		serverHint.hidden = !l.server;
		serverHint.textContent = t('policy.serverLocked');
	}

	const banner = $('#policy-banner');
	if (banner) {
		banner.hidden = !policyState.managed;
		banner.textContent = t('policy.managedBanner');
	}
	applySplitPolicy();
}

/** Policy changed in main: re-read the (possibly forced) settings and lock the UI. */
async function onPolicyState(st) {
	if (!st) return;
	policyState = st;
	try {
		const cfg = await config.getAll();
		if (cfg) {
			el.optAutostart.checked = cfg.app?.startWithWindows ?? true;
			el.optAutoconnect.checked = cfg.tunnel?.autoConnect ?? true;
			view.autoConnect = el.optAutoconnect.checked;
			el.optSplitTunnel.checked = cfg.tunnel?.splitTunnel ?? false;
			view.splitTunnel = el.optSplitTunnel.checked;
			state = { ...state, killSwitch: cfg.tunnel?.killSwitch ?? state.killSwitch };
		}
	} catch { /* keep the current view */ }
	renderSplitMode();
	renderRouting();
	updateUI();
	applyPolicyUi();
}

clientPolicy.onChange((st) => { onPolicyState(st); });
clientPolicy.get().then((st) => onPolicyState(st)).catch(() => {});
