'use strict';

// recoverKillSwitch() itself lives in core (src/lifecycle/killswitch-startup.js,
// unit-tested there); this checks how main.js wires it up.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('main.js kill-switch wiring', () => {
	const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');

	it('uses the shared core implementation', () => {
		assert.doesNotMatch(main, /require\('\.\/killswitch-startup'\)/);
		assert.match(main, /recoverKillSwitch[\s\S]*?require\('@gatecontrol\/client-core[^']*'\)/);
	});

	it('runs the startup recovery', () => {
		assert.match(main, /await recoverKillSwitch\(\{ killSwitch, store, wgService, log \}\)/);
	});

	it('no longer keeps stale rules at startup', () => {
		assert.doesNotMatch(main, /Kill-Switch war beim letzten Beenden aktiv/);
	});

	it('does not swallow kill-switch disable errors', () => {
		assert.doesNotMatch(main, /killSwitch\.disable\(\);\s*\}\s*catch\s*\{\s*\}/);
	});
});
