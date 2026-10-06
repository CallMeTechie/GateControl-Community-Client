/**
 * GateControl – Preload Script
 * Sichere Bridge zwischen Main und Renderer Process (gemeinsamer Teil aus
 * dem Core: createBridgeApi).
 */

const { contextBridge, ipcRenderer } = require('electron');
const { i18n, createBridgeApi } = require('@gatecontrol/client-core');
const { registerTranslations } = i18n;

registerTranslations('de', require('../i18n/de.json'));
registerTranslations('en', require('../i18n/en.json'));

// Community meldet fertige Updates auf 'update-ready'.
const api = createBridgeApi(ipcRenderer, i18n, { updateReadyChannel: 'update-ready' });

// Kurze Geräte-ID (erste 8 Hex des Machine-Fingerprints) oder null.
api.getDeviceId = () => ipcRenderer.invoke('app:device-id');

// Fenster maximieren/wiederherstellen (eigene Titelleiste, main.js)
api.window.toggleMaximize = () => ipcRenderer.send('window:toggle-maximize');

contextBridge.exposeInMainWorld('gatecontrol', api);
