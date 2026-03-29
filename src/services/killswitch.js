/**
 * GateControl – Kill-Switch Service
 * 
 * Blockiert allen Netzwerkverkehr außer:
 * - WireGuard-Tunnel-Traffic
 * - DNS über VPN
 * - Lokales Netzwerk
 * - GateControl Server-Kommunikation
 * 
 * Implementiert über Windows Firewall (netsh advfirewall)
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;

const execAsync = promisify(exec);

class KillSwitch {
	constructor(log) {
		this.log = log;
		this.rulePrefix = 'GateControl_KS';
		this.enabled = false;
	}
	
	/**
	 * Kill-Switch aktivieren
	 * Erstellt Firewall-Regeln die allen Traffic blockieren
	 * außer WireGuard-Tunnel und lokale Kommunikation
	 */
	async enable(configPath) {
		if (this.enabled) {
			this.log.debug('Kill-Switch bereits aktiv');
			return;
		}
		
		this.log.info('Aktiviere Kill-Switch...');
		
		// Config parsen um Endpoint und AllowedIPs zu extrahieren
		let endpoint = null;
		let vpnSubnet = null;
		
		try {
			const config = await fs.readFile(configPath, 'utf-8');
			const parsed = this._parseConfig(config);
			endpoint = parsed.endpoint;
			vpnSubnet = parsed.vpnSubnet;
		} catch (err) {
			this.log.warn('Config konnte nicht geparst werden:', err.message);
		}
		
		try {
			// Bestehende Regeln entfernen
			await this._removeAllRules();
			
			// 1. ALLOW: Loopback (localhost)
			await this._addRule({
				name: `${this.rulePrefix}_Allow_Loopback`,
				dir: 'out',
				action: 'allow',
				remoteip: '127.0.0.0/8',
			});
			
			// 2. ALLOW: Lokales Netzwerk
			for (const subnet of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
				await this._addRule({
					name: `${this.rulePrefix}_Allow_LAN_${subnet.replace(/[./]/g, '_')}`,
					dir: 'out',
					action: 'allow',
					remoteip: subnet,
				});
			}
			
			// 3. ALLOW: WireGuard Endpoint (VPN-Server)
			if (endpoint) {
				const { host, port } = endpoint;
				await this._addRule({
					name: `${this.rulePrefix}_Allow_WG_Endpoint`,
					dir: 'out',
					action: 'allow',
					remoteip: host,
					remoteport: port,
					protocol: 'udp',
				});
			}
			
			// 4. ALLOW: VPN-Subnetz
			if (vpnSubnet) {
				await this._addRule({
					name: `${this.rulePrefix}_Allow_VPN_Subnet`,
					dir: 'out',
					action: 'allow',
					remoteip: vpnSubnet,
				});
			}
			
			// 5. ALLOW: DHCP
			await this._addRule({
				name: `${this.rulePrefix}_Allow_DHCP`,
				dir: 'out',
				action: 'allow',
				protocol: 'udp',
				localport: '68',
				remoteport: '67',
			});
			
			// 6. BLOCK: Alles andere (Outbound)
			await this._addRule({
				name: `${this.rulePrefix}_Block_All_Out`,
				dir: 'out',
				action: 'block',
				remoteip: 'any',
			});
			
			// 7. BLOCK: Alles andere (Inbound)
			await this._addRule({
				name: `${this.rulePrefix}_Block_All_In`,
				dir: 'in',
				action: 'block',
				remoteip: 'any',
			});
			
			this.enabled = true;
			this.log.info('Kill-Switch aktiviert');
			
		} catch (err) {
			this.log.error('Kill-Switch Aktivierung fehlgeschlagen:', err);
			// Aufräumen bei Fehler
			await this._removeAllRules();
			throw err;
		}
	}
	
	/**
	 * Kill-Switch deaktivieren
	 */
	async disable() {
		this.log.info('Deaktiviere Kill-Switch...');
		await this._removeAllRules();
		this.enabled = false;
		this.log.info('Kill-Switch deaktiviert');
	}
	
	/**
	 * Prüft ob Kill-Switch aktiv ist
	 */
	async isActive() {
		try {
			const { stdout } = await execAsync(
				`netsh advfirewall firewall show rule name="${this.rulePrefix}_Block_All_Out"`
			);
			return stdout.includes(this.rulePrefix);
		} catch {
			return false;
		}
	}
	
	/**
	 * Firewall-Regel hinzufügen
	 */
	async _addRule({ name, dir, action, protocol, remoteip, remoteport, localport }) {
		let cmd = `netsh advfirewall firewall add rule name="${name}" dir=${dir} action=${action}`;
		
		if (protocol)   cmd += ` protocol=${protocol}`;
		else            cmd += ' protocol=any';
		if (remoteip)   cmd += ` remoteip=${remoteip}`;
		if (remoteport) cmd += ` remoteport=${remoteport}`;
		if (localport)  cmd += ` localport=${localport}`;
		
		cmd += ' enable=yes';
		
		this.log.debug(`Firewall-Regel: ${cmd}`);
		await execAsync(cmd);
	}
	
	/**
	 * Alle GateControl Kill-Switch Regeln entfernen
	 */
	async _removeAllRules() {
		try {
			// Alle Regeln mit Prefix finden und entfernen
			const { stdout } = await execAsync(
				'netsh advfirewall firewall show rule name=all'
			);
			
			const rules = stdout.split('\n')
				.filter(line => line.includes(this.rulePrefix))
				.map(line => {
					const match = line.match(/Regelname:\s*(.+)/);
					return match ? match[1].trim() : null;
				})
				.filter(Boolean);
			
			for (const rule of rules) {
				await execAsync(`netsh advfirewall firewall delete rule name="${rule}"`).catch(() => {});
			}
			
			// Sicherheitshalber auch direkt per Prefix löschen
			await execAsync(
				`netsh advfirewall firewall delete rule name="${this.rulePrefix}_Block_All_Out"`
			).catch(() => {});
			
			await execAsync(
				`netsh advfirewall firewall delete rule name="${this.rulePrefix}_Block_All_In"`
			).catch(() => {});
			
			await execAsync(
				`netsh advfirewall firewall delete rule name="${this.rulePrefix}_Allow_Loopback"`
			).catch(() => {});
			
			await execAsync(
				`netsh advfirewall firewall delete rule name="${this.rulePrefix}_Allow_WG_Endpoint"`
			).catch(() => {});
			
			await execAsync(
				`netsh advfirewall firewall delete rule name="${this.rulePrefix}_Allow_VPN_Subnet"`
			).catch(() => {});
			
			await execAsync(
				`netsh advfirewall firewall delete rule name="${this.rulePrefix}_Allow_DHCP"`
			).catch(() => {});
			
			// LAN-Regeln
			for (const subnet of ['10_0_0_0_8', '172_16_0_0_12', '192_168_0_0_16']) {
				await execAsync(
					`netsh advfirewall firewall delete rule name="${this.rulePrefix}_Allow_LAN_${subnet}"`
				).catch(() => {});
			}
			
		} catch (err) {
			this.log.debug('Regel-Cleanup:', err.message);
		}
	}
	
	/**
	 * Config parsen für Endpoint-Extraktion
	 */
	_parseConfig(content) {
		let endpoint = null;
		let vpnSubnet = null;
		
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			
			const epMatch = trimmed.match(/^Endpoint\s*=\s*(.+):(\d+)$/);
			if (epMatch) {
				endpoint = { host: epMatch[1], port: epMatch[2] };
			}
			
			const addrMatch = trimmed.match(/^Address\s*=\s*(.+)$/);
			if (addrMatch) {
				// z.B. 10.8.0.2/24 → 10.8.0.0/24
				const cidr = addrMatch[1].trim().split(',')[0].trim();
				const parts = cidr.split('/');
				if (parts.length === 2) {
					const ip = parts[0].split('.');
					const mask = parseInt(parts[1], 10);
					if (mask <= 24) {
						ip[3] = '0';
						vpnSubnet = `${ip.join('.')}/${mask}`;
					} else {
						vpnSubnet = cidr;
					}
				}
			}
		}
		
		return { endpoint, vpnSubnet };
	}
}

module.exports = KillSwitch;
