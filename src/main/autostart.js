/**
 * Autostart with Windows (Community).
 *
 * The app runs with requireAdministrator, and Windows does not start
 * elevated programs from the Run key (login items) — the old autostart via
 * app.setLoginItemSettings never started the app. It is a Task Scheduler
 * task with a logon trigger now, like Pro. The task comes from a task XML
 * (core utils/autostart-task): no 3-day execution time limit, starts and
 * keeps running on battery, normal priority, elevated, 10 s after logon.
 *
 * Called on every start: autostart on → the task is created / replaced
 * (/F) and the old Run-key entry removed; autostart off → task and Run-key
 * entry are removed. Installations with the old Run-key autostart get the
 * task on their next start or update.
 */

'use strict';

const AUTOSTART_TASK = 'GateControlCommunityAutostart';
// As the Run-key entry had it (the app starts in the tray per app.startMinimized).
const AUTOSTART_ARGS = Object.freeze(['--minimized']);

/**
 * The exe Windows should start: the portable build runs from a temporary
 * copy, PORTABLE_EXECUTABLE_FILE is the file the user keeps.
 */
function autostartExePath(env, getExePath) {
	const portable = env && env.PORTABLE_EXECUTABLE_FILE;
	return typeof portable === 'string' && portable.trim() ? portable.trim() : getExePath();
}

/**
 * @param {object} o
 * @param {object} o.autostartTask - core utils/autostart-task
 * @param {(file: string, args: string[], opts?: object) => Promise<any>} o.execFile
 * @param {() => string} o.getExePath - app.getPath('exe')
 * @param {() => string} o.getTempPath - app.getPath('temp') (only without %ProgramData%)
 * @param {() => void} o.removeLoginItem - removes the old Run-key entry
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {object} o.log
 * @returns {(enabled: boolean) => Promise<void>}
 */
function createAutostart(o) {
	const env = o.env || process.env;
	const run = (file, args) => o.execFile(file, args, { windowsHide: true });

	function removeLoginItem() {
		try {
			o.removeLoginItem();
		} catch (err) {
			o.log.warn(`Autostart: removing the old Run-key entry failed: ${err && err.message}`);
		}
	}

	async function taskExists() {
		try {
			await run('schtasks', ['/Query', '/TN', AUTOSTART_TASK]);
			return true;
		} catch {
			return false;
		}
	}

	return async function setAutostartTask(enabled) {
		if (enabled) {
			const exePath = autostartExePath(env, o.getExePath);
			const mode = await o.autostartTask.registerAutostartTask({
				taskName: AUTOSTART_TASK,
				command: exePath,
				args: [...AUTOSTART_ARGS],
				userId: o.autostartTask.currentUserId(env),
				description: 'Starts GateControl Community Client when you sign in to Windows.',
				// The task XML goes into a new folder there (owned by the
				// administrators); in the user's temp folder a normal process could
				// swap the file before the elevated schtasks reads it.
				dir: env.ProgramData || o.getTempPath(),
				execFile: run,
				log: o.log,
			});
			// Only once the task exists: the Run-key entry is the old autostart.
			removeLoginItem();
			o.log.info(`Autostart enabled: ${exePath} (task ${mode})`);
		} else {
			removeLoginItem();
			if (await taskExists()) {
				await run('schtasks', o.autostartTask.schtasksDeleteArgs(AUTOSTART_TASK));
				o.log.info('Autostart disabled');
			}
		}
	};
}

module.exports = { createAutostart, autostartExePath, AUTOSTART_TASK, AUTOSTART_ARGS };
