# GateControl Windows Client

Electron-basierter WireGuard VPN-Client mit nativer WireGuard-Integration (FFI), Tray-Icon, Auto-Connect, Kill-Switch und Server-Anbindung an [GateControl](https://github.com/CallMeTechie/gatecontrol).

## Features

| Feature | Beschreibung |
|---------|-------------|
| **Native WireGuard** | Direkte FFI-Anbindung an `wireguard.dll` / `wintun.dll` via Koffi — keine Installation nötig |
| **Auto-Connect** | Verbindet beim Windows-Start automatisch |
| **Auto-Update** | Prüft automatisch auf neue Versionen, stiller Download, Update-Banner |
| **Split-Tunneling** | Nur bestimmte IPs/Subnetze durch den VPN-Tunnel leiten |
| **Kill-Switch** | Blockiert allen Traffic außerhalb des VPN-Tunnels (Windows Firewall) |
| **Erreichbare Dienste** | Zeigt alle Server-Routen als klickbare Liste nach Verbindungsaufbau |
| **DNS-Leak-Test** | Prüft ob DNS-Anfragen durch den VPN-Tunnel gehen |
| **Peer-Ablauf-Warnung** | Benachrichtigung 7/3/1 Tag vor Ablauf des VPN-Zugangs |
| **Traffic-Verbrauch** | Datenverbrauch (24h, 7 Tage, 30 Tage, Gesamt) vom Server |
| **Bandbreiten-Graph** | Live-Canvas-Graph mit aktueller Download-/Upload-Geschwindigkeit |
| **Tray-Icon** | Status-Anzeige, Tooltip mit Server-URL, Verbindungsdauer und Traffic |
| **Config-Import** | Per `.conf`-Datei oder QR-Code (Webcam) |
| **Server-Integration** | Config-Pull, automatische Updates, Heartbeat & Status-Reporting |
| **Auto-Reconnect** | Exponential Backoff bei Verbindungsabbruch (2s → 60s, max 10 Versuche) |

## Voraussetzungen

- **Windows 10/11** (64-Bit)
- **Administrator-Rechte** (für WireGuard-Adapter und Firewall-Regeln)
- **Node.js 24** (nur für Entwicklung; mindestens 22.12 für Electron 44)
- **GateControl Server** mit API-Token (Scope: `client`)

> **Hinweis:** WireGuard muss **nicht** separat installiert werden. Die benötigten DLLs (`wireguard.dll`, `wintun.dll`) sind in `resources/bin/` eingebettet.

## Schnellstart

### Installation (Endbenutzer)

1. `GateControl Setup.exe` herunterladen und installieren
2. App starten (läuft als Administrator)
3. Unter **Settings**: Server-URL und API-Key eingeben
4. **Test Connection** → **Save & Register**
5. Auf der Status-Seite **Connect** drücken

### API-Token erstellen

Im GateControl Web-UI unter **Settings → API Tokens**:

- **Name:** z.B. `Windows Client`
- **Scope:** `Client App` (unter Integration)
- Token kopieren und im Client eingeben

## Entwicklung

```powershell
git clone https://github.com/CallMeTechie/GateControl-Windows-Client.git
cd GateControl-Windows-Client

npm install

# Entwicklungsmodus
npm run dev

# Produktions-Start
npm start
```

## Core-Abhängigkeit (gatecontrol-client-core)

Die gemeinsame Logik liegt in [gatecontrol-client-core](https://github.com/CallMeTechie/gatecontrol-client-core). Welcher Core-Stand gebaut wird, ist in **`core.ref`** als vollständiger 40-stelliger Commit-SHA festgelegt. Alle Workflows (PR-Check, Security, Release) holen genau diesen Commit nach `.core` (`scripts/fetch-core.sh --link`) – ein neuer Merge in Core ändert einen Client-Build also erst, wenn `core.ref` angehoben wird.

**Lokale Entwicklung:** `package.json` zeigt auf den Nachbar-Checkout `../gatecontrol-client-core`. Diesen auf den gepinnten Stand bringen (legt das Verzeichnis bei Bedarf an, bricht bei uncommitteten Änderungen ab):

```bash
npm run core:fetch -- ../gatecontrol-client-core
npm install
```

**Core anheben:**

```bash
npm run core:bump             # core.ref auf aktuellen core master setzen
npm run core:bump -- <SHA>    # oder auf einen bestimmten Commit
npm run core:fetch -- ../gatecontrol-client-core && npm test
```

Die Änderung an `core.ref` per Pull Request einreichen; der PR-Check testet dann gegen den neuen Core-Stand.

## Build

```powershell
# NSIS Installer (.exe)
npm run build:installer

# Portable Version (.zip)
npm run build:portable

# Standard Build
npm run build

# Output in ./dist/
```

## Architektur

```
┌──────────────────────────────────────────────────────┐
│  Electron App                                        │
│                                                      │
│   Renderer (UI)          Main Process                │
│  ┌──────────────┐       ┌────────────────────────┐   │
│  │  Status       │  IPC  │  WireGuard Service     │   │
│  │  Settings     │◄────►│  → wireguard.dll (FFI) │   │
│  │  Logs         │       │  → wintun.dll          │   │
│  └──────────────┘       ├────────────────────────┤   │
│                          │  Kill-Switch            │   │
│   preload.js             │  → netsh (Firewall)    │   │
│   (Context Bridge)       ├────────────────────────┤   │
│                          │  API Client             │   │
│                          │  → /api/v1/client/*    │   │
│                          ├────────────────────────┤   │
│                          │  Connection Monitor     │   │
│                          │  → Handshake + Reconnect│   │
│                          └────────────────────────┘   │
└──────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌──────────────────────────┐
              │  GateControl Server      │
              │  (WireGuard + Caddy)     │
              └──────────────────────────┘
```

## Projektstruktur

```
GateControl-Windows-Client/
├── package.json
├── build/
│   └── icon.ico                    # App-Icon (Multi-Resolution)
├── resources/
│   ├── bin/
│   │   ├── wireguard.dll           # WireGuard-NT Library
│   │   └── wintun.dll              # Wintun TUN-Adapter
│   └── icons/
│       ├── tray-connected.png      # Grün (16x16)
│       ├── tray-connecting.png     # Gelb (16x16)
│       └── tray-disconnected.png   # Grau (16x16)
├── scripts/
│   └── installer.nsh               # NSIS Installer-Anpassungen
├── src/
│   ├── main/
│   │   ├── main.js                 # Electron Main Process
│   │   └── preload.js              # Context Bridge (IPC Security)
│   ├── renderer/
│   │   ├── index.html              # UI Markup
│   │   ├── renderer.js             # UI Logik & State
│   │   └── styles/
│   │       └── app.css             # Design System (Dark Theme)
│   └── services/
│       ├── wireguard-native.js     # WireGuard FFI (Koffi)
│       ├── api-client.js           # GateControl Server API
│       ├── killswitch.js           # Windows Firewall Kill-Switch
│       └── connection-monitor.js   # Verbindungsüberwachung
└── dist/                           # Build Output
```

## Server-API

Der Client kommuniziert ausschließlich über `/api/v1/client/*` Endpoints:

| Endpoint | Methode | Funktion |
|----------|---------|----------|
| `/api/v1/client/ping` | GET | Verbindungstest |
| `/api/v1/client/register` | POST | Client als Peer registrieren |
| `/api/v1/client/config` | GET | WireGuard-Konfiguration abrufen |
| `/api/v1/client/config/check` | GET | Config-Update prüfen (Hash-Vergleich) |
| `/api/v1/client/heartbeat` | POST | Status & Traffic-Statistiken senden |
| `/api/v1/client/status` | POST | Verbindungsstatus melden |

### Authentifizierung

```
X-API-Token: gc_xxxxxxxxxxxxxxxxxxxxxxxx
X-Client-Version: 1.0.0
X-Client-Platform: windows
```

Benötigter Token-Scope: **`client`** (oder `full-access`)

## Kill-Switch

Erstellt Windows-Firewall-Regeln (Whitelist-Ansatz):

| Regel | Richtung | Aktion |
|-------|----------|--------|
| Loopback (127.0.0.0/8) | Out | Allow |
| LAN (10/8, 172.16/12, 192.168/16) | Out | Allow |
| WireGuard Endpoint (UDP) | Out | Allow |
| VPN-Subnetz | Out | Allow |
| DHCP (UDP 67/68) | Out | Allow |
| Alles andere | In + Out | Block |

Alle Regeln tragen den Prefix `GateControl_Community_KS_` (der Pro Client nutzt `GateControl_Pro_KS_`) und werden beim Deaktivieren oder Deinstallieren vollständig entfernt; Regeln des jeweils anderen Clients bleiben unangetastet. Altregeln mit dem früheren gemeinsamen Prefix `GateControl_KS_` werden nur entfernt, wenn der Pro Client weder installiert ist noch läuft.

## Konfiguration

### Speicherorte

| Datei | Pfad |
|-------|------|
| App-Config (verschlüsselt) | `%APPDATA%/gatecontrol-client/gatecontrol-config.json` |
| WireGuard-Config | `%APPDATA%/gatecontrol-client/wireguard/gatecontrol0.conf` |
| Logs | `%APPDATA%/gatecontrol-client/logs/main.log` |
| Autostart | Registry: `HKCU\...\Run\GateControl` |

### App-Einstellungen

| Option | Standard | Beschreibung |
|--------|----------|-------------|
| Auto-Connect | An | Verbindet beim App-Start |
| Kill-Switch | Aus | Blockiert Non-VPN-Traffic |
| Start minimiert | An | Startet im Tray |
| Windows-Autostart | An | Startet mit Windows |
| Check-Intervall | 30s | Verbindungsprüfung |
| Config-Polling | 300s | Server-Config-Update |

## Tray-Icon

| Zustand | Farbe | Bedeutung |
|---------|-------|-----------|
| Getrennt | Grau | Kein aktiver Tunnel |
| Verbinde | Gelb | Tunnel wird aufgebaut / Reconnect |
| Verbunden | Grün | Tunnel aktiv, Handshake OK |

## Technologie-Stack

| Komponente | Technologie | Version |
|-----------|------------|---------|
| Framework | Electron | 44 |
| VPN | WireGuard-NT (FFI) | via Koffi 2.9 |
| HTTP | Axios | 1.7 |
| Storage | electron-store | 8.2 (verschlüsselt) |
| Logging | electron-log | 5.1 |
| QR-Scanner | jsqr | 1.4 |
| Build | electron-builder | 26 (NSIS) |

## Signierte Updates

Der Client hat kein Authenticode-Zertifikat. Auto-Updates sind deshalb mit einem eigenen Ed25519-Schlüssel abgesichert:

- Die Release-Pipeline (`scripts/sign-update.js`) schreibt zu jedem Release `update-manifest.json` (Produkt, Version, Dateiname, SHA-256 und Größe des Installers) und die Signatur `update-manifest.json.sig` und lädt beide als Release-Assets hoch. Der private Schlüssel liegt ausschließlich im GitHub-Secret `UPDATE_SIGNING_KEY`.
- Der Client installiert nur Updates, deren Manifest mit dem Public Key aus `build/update-signing.pub` gültig signiert ist und deren Download Größe und SHA-256 aus dem Manifest trifft. Unsignierte Updates werden abgelehnt.
- Solange `build/update-signing.pub` den Platzhalter `REPLACE_WITH_UPDATE_PUBLIC_KEY` enthält, ist der Auto-Updater im Client deaktiviert und die Release-Pipeline bricht ab.

**Einmalig einrichten** (lokal, der private Schlüssel verlässt den Rechner nur als Secret):

```bash
# Schlüsselpaar erzeugen (OpenSSL)
openssl genpkey -algorithm ed25519 -out gc-update-signing.pem
openssl pkey -in gc-update-signing.pem -pubout -out update-signing.pub

# Alternative ohne OpenSSL (Node.js)
node -e "const c=require('crypto'),fs=require('fs');const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');fs.writeFileSync('gc-update-signing.pem',privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync('update-signing.pub',publicKey.export({type:'spki',format:'pem'}))"
```

1. Secret `UPDATE_SIGNING_KEY` mit dem **Inhalt** von `gc-update-signing.pem` in **beiden** Client-Repos (Pro und Community) anlegen – derselbe Schlüssel für beide, z. B. `gh secret set UPDATE_SIGNING_KEY < gc-update-signing.pem` (einmal pro Repo).
2. `update-signing.pub` in **beiden** Repos als `build/update-signing.pub` committen (ersetzt den Platzhalter).
3. `gc-update-signing.pem` sicher offline aufbewahren (Passwort-Manager/Tresor) und vom Arbeitsrechner löschen. Geht der Schlüssel verloren, muss ein neuer Public Key ausgeliefert werden; installierte Clients mit dem alten Key nehmen danach signierte Updates erst nach einer manuellen Neuinstallation an.

## Update-Kanal und Pflicht-Updates

Welche Builds ein Client angeboten bekommt, legt der GateControl-Server fest (Einstellungen → Client-Updates bzw. pro Peer):

- **Kanal** `stable` (Standard, neueste reguläre Version) oder `beta` (zusätzlich GitHub-Pre-Releases). Der Client zeigt den zugewiesenen Kanal unter Einstellungen → Über nur an; wählen kann er ihn nicht.
- **Mindestversion** pro Produkt. Liegt die installierte Version darunter und ist ein geprüftes, neueres Update heruntergeladen, erscheint „Update erforderlich“: ein Hinweis ohne Schließen-Knopf auf der Übersicht, die Update-Karte in der Seitenleiste ohne „Später“, ein Eintrag ganz oben im Tray-Menü und eine Benachrichtigung (bei jedem App-Start erneut).
- Kanal, Mindestversion und `mandatory` sind **nicht** signiert und dienen nur der Anzeige. Signatur, Produkt, Version (strikt neuer – kein Downgrade), Größe und SHA-256 werden immer geprüft; der Server kann so weder unsignierte Builds noch ältere Versionen ausrollen.
- Ein Pflicht-Update wird **nicht automatisch** installiert: Der Installer beendet die App und trennt den VPN-Tunnel (Kill-Switch wird vorher gelöst). Das soll nicht ohne Zutun mitten in einer Sitzung passieren – der Nutzer startet die Installation über Hinweis, Karte oder Tray.

## Lizenz

MIT
