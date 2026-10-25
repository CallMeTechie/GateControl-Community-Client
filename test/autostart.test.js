'use strict';

// Autostart with Windows (Community): a Task Scheduler task from a task XML
// (core utils/autostart-task) instead of the Run key, which Windows ignores
// for an app with requireAdministrator. On / off also remove the old Run-key
// entry (migration of existing installations).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutostart, autostartExePath, AUTOSTART_TASK, AUTOSTART_ARGS } = require('../src/main/autostart');
const autostartTask = require('@gatecontrol/client-core/src/utils/autostart-task');

const EXE = 'C:\\Program Files\\GateControl Community Client\\GateControl Community Client.exe';

function logDouble() {
	const lines = [];
	return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) };
}

/** Text of the first <tag> element. */
function tag(xml, name) {
	const m = xml.match(new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`));
	return m ? m[1] : null;
}

function setup({ env, execFile, removeLoginItem } = {}) {
	const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-programdata-'));
	const calls = [];
	const log = logDouble();
	let loginItemRemoved = 0;
	const set = createAutostart({
		autostartTask,
		env: { ProgramData: programData, USERDOMAIN: 'PC01', USERNAME: 'maria', ...(env || {}) },
		getExePath: () => EXE,
		getTempPath: () => { throw new Error('temp must not be used'); },
		removeLoginItem: removeLoginItem || (() => { loginItemRemoved += 1; calls.push({ file: 'loginItem' }); }),
		execFile: async (file, args, opts) => {
			const i = args.indexOf('/XML');
			const xml = i >= 0 ? fs.readFileSync(args[i + 1]).subarray(2).toString('utf16le') : null;
			calls.push({ file, args, opts, xml });
			if (execFile) return execFile(file, args);
			return { stdout: '' };
		},
		log,
	});
	return { set, calls, log, programData, removed: () => loginItemRemoved, done: () => fs.rmSync(programData, { recursive: true, force: true }) };
}

describe('autostart task (Community)', () => {
	it('on: task from XML with the corrected settings, then the old Run-key entry goes', async () => {
		const t = setup();
		await t.set(true);
		assert.equal(t.calls.length, 2);
		const c = t.calls[0];
		assert.equal(c.file, 'schtasks');
		assert.deepEqual(c.args.slice(0, 5), ['/Create', '/F', '/TN', 'GateControlCommunityAutostart', '/XML']);
		assert.deepEqual(c.opts, { windowsHide: true });
		assert.equal(path.dirname(path.dirname(c.args[5])), t.programData);
		assert.equal(tag(c.xml, 'ExecutionTimeLimit'), 'PT0S');
		assert.equal(tag(c.xml, 'DisallowStartIfOnBatteries'), 'false');
		assert.equal(tag(c.xml, 'StopIfGoingOnBatteries'), 'false');
		assert.equal(tag(c.xml, 'Priority'), '4');
		assert.equal(tag(c.xml, 'MultipleInstancesPolicy'), 'IgnoreNew');
		assert.equal(tag(c.xml, 'RunLevel'), 'HighestAvailable');
		assert.equal(tag(c.xml, 'Delay'), 'PT10S');
		assert.equal(tag(c.xml, 'Command'), EXE);
		// same start argument as the Run-key entry had
		assert.equal(tag(c.xml, 'Arguments'), '--minimized');
		assert.deepEqual([...AUTOSTART_ARGS], ['--minimized']);
		assert.match(c.xml, /<UserId>PC01\\maria<\/UserId>/);
		// Run key removed after the task exists
		assert.equal(t.calls[1].file, 'loginItem');
		assert.ok(t.log.lines.includes(`info Autostart enabled: ${EXE} (task xml)`), t.log.lines.join('\n'));
		assert.deepEqual(fs.readdirSync(t.programData), [], 'task XML removed');
		t.done();
	});

	it('on, every start: the task is replaced again (/F)', async () => {
		const t = setup();
		await t.set(true);
		await t.set(true);
		const creates = t.calls.filter((c) => c.file === 'schtasks');
		assert.equal(creates.length, 2);
		assert.ok(creates.every((c) => c.args[0] === '/Create' && c.args[1] === '/F'));
		t.done();
	});

	it('on, task cannot be created: the Run-key entry stays, the error reaches the caller', async () => {
		const t = setup({ execFile: async () => { throw new Error('Access is denied.'); } });
		await assert.rejects(t.set(true), /Access is denied/);
		assert.equal(t.removed(), 0);
		t.done();
	});

	it('off: Run-key entry removed, existing task deleted', async () => {
		const t = setup();
		await t.set(false);
		assert.equal(t.removed(), 1);
		const sch = t.calls.filter((c) => c.file === 'schtasks').map((c) => c.args);
		assert.deepEqual(sch, [
			['/Query', '/TN', 'GateControlCommunityAutostart'],
			['/Delete', '/F', '/TN', 'GateControlCommunityAutostart'],
		]);
		assert.ok(t.log.lines.includes('info Autostart disabled'));
		t.done();
	});

	it('off without a task: nothing to delete, no error', async () => {
		const t = setup({ execFile: async (file, args) => { if (args[0] === '/Query') throw new Error('ERROR: The system cannot find the file specified.'); } });
		await t.set(false);
		assert.equal(t.removed(), 1);
		assert.deepEqual(t.calls.filter((c) => c.file === 'schtasks').map((c) => c.args[0]), ['/Query']);
		t.done();
	});

	it('a failing Run-key removal only logs', async () => {
		const t = setup({ removeLoginItem: () => { throw new Error('registry'); } });
		await t.set(true);
		await t.set(false);
		assert.ok(t.log.lines.some((l) => l.startsWith('warn') && l.includes('registry')));
		t.done();
	});

	it('portable build: the kept exe, not the temporary copy', async () => {
		assert.equal(autostartExePath({ PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\GateControl.exe' }, () => EXE), 'D:\\Tools\\GateControl.exe');
		assert.equal(autostartExePath({ PORTABLE_EXECUTABLE_FILE: ' ' }, () => EXE), EXE);
		assert.equal(autostartExePath({}, () => EXE), EXE);
		const t = setup({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\GateControl.exe' } });
		await t.set(true);
		assert.equal(tag(t.calls[0].xml, 'Command'), 'D:\\Tools\\GateControl.exe');
		t.done();
	});

	it('own task name, never the Pro task', () => {
		assert.equal(AUTOSTART_TASK, 'GateControlCommunityAutostart');
		assert.notEqual(AUTOSTART_TASK, 'GateControlProAutostart');
	});
});
