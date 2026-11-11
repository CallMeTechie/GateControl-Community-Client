/**
 * GateControl – Preload Script
 * Sichere Bridge zwischen Main und Renderer Process (gemeinsamer Teil aus
 * dem Core: createBridgeApi).
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { i18n, createBridgeApi } = require('@gatecontrol/client-core');
const { registerTranslations } = i18n;

registerTranslations('de', require('../i18n/de.json'));
registerTranslations('en', require('../i18n/en.json'));

// Community meldet fertige Updates auf 'update-ready'.
// webUtils: paths of files dropped on the window (GateDrop send dialog).
const api = createBridgeApi(ipcRenderer, i18n, { updateReadyChannel: 'update-ready', webUtils });

// Der Core bringt die Brücke für alle Funktionen mit. Drive, Mail, Notizen und
// Kameras gibt es in der Community-App nicht: main.js übergibt diese Dienste
// nicht an registerBaseHandlers, also bedient niemand ihre Kanäle – der
// Renderer bekommt sie gar nicht erst.
for (const key of ['drive', 'mail', 'notes', 'cameras']) delete api[key];

// Kurze Geräte-ID (erste 8 Hex des Machine-Fingerprints) oder null.
api.getDeviceId = () => ipcRenderer.invoke('app:device-id');

// Fenster maximieren/wiederherstellen (eigene Titelleiste, main.js)
api.window.toggleMaximize = () => ipcRenderer.send('window:toggle-maximize');

contextBridge.exposeInMainWorld('gatecontrol', api);
