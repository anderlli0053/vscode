/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { gracefulify } from 'graceful-fs';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as minimist from 'minimist';
import * as rimraf from 'rimraf';
import * as mkdirp from 'mkdirp';
import * as vscodetest from '@vscode/test-electron';
import fetch from 'node-fetch';
import { Quality, MultiLogger, Logger, ConsoleLogger, FileLogger, measureAndLog, getDevElectronPath, getBuildElectronPath, getBuildVersion } from '../../automation';
import { retry, timeout } from './utils';

import { setup as setupDataLossTests } from './areas/workbench/data-loss.test';
import { setup as setupPreferencesTests } from './areas/preferences/preferences.test';
import { setup as setupSearchTests } from './areas/search/search.test';
import { setup as setupNotebookTests } from './areas/notebook/notebook.test';
import { setup as setupLanguagesTests } from './areas/languages/languages.test';
import { setup as setupStatusbarTests } from './areas/statusbar/statusbar.test';
import { setup as setupExtensionTests } from './areas/extensions/extensions.test';
import { setup as setupMultirootTests } from './areas/multiroot/multiroot.test';
import { setup as setupLocalizationTests } from './areas/workbench/localization.test';
import { setup as setupLaunchTests } from './areas/workbench/launch.test';
import { setup as setupTerminalTests } from './areas/terminal/terminal.test';

const rootPath = path.join(__dirname, '..', '..', '..');

const [, , ...args] = process.argv;
const opts = minimist(args, {
	string: [
		'browser',
		'build',
		'stable-build',
		'wait-time',
		'test-repo',
		'electronArgs'
	],
	boolean: [
		'verbose',
		'remote',
		'web',
		'headless',
		'legacy',
		'tracing'
	],
	default: {
		verbose: false
	}
}) as {
	verbose?: boolean;
	remote?: boolean;
	headless?: boolean;
	web?: boolean;
	legacy?: boolean;
	tracing?: boolean;
	build?: string;
	'stable-build'?: string;
	browser?: string;
	electronArgs?: string;
};

const logsPath = (() => {
	const logsParentPath = path.join(rootPath, '.build', 'logs');

	let logsName: string;
	if (opts.web) {
		logsName = 'smoke-tests-browser';
	} else if (opts.remote) {
		logsName = opts.legacy ? 'smoke-tests-remote-legacy' : 'smoke-tests-remote';
	} else {
		logsName = opts.legacy ? 'smoke-tests-electron-legacy' : 'smoke-tests-electron';
	}

	return path.join(logsParentPath, logsName);
})();

const logger = createLogger();

function createLogger(): Logger {
	const loggers: Logger[] = [];

	// Log to console if verbose
	if (opts.verbose) {
		loggers.push(new ConsoleLogger());
	}

	// Prepare logs path
	fs.rmSync(logsPath, { recursive: true, force: true, maxRetries: 3 });
	mkdirp.sync(logsPath);

	// Always log to log file
	loggers.push(new FileLogger(path.join(logsPath, 'smoke-test-runner.log')));

	return new MultiLogger(loggers);
}

try {
	gracefulify(fs);
} catch (error) {
	logger.log(`Error enabling graceful-fs: ${error}`);
}

const testDataPath = path.join(os.tmpdir(), 'vscsmoke');
if (fs.existsSync(testDataPath)) {
	rimraf.sync(testDataPath);
}
fs.mkdirSync(testDataPath);
process.once('exit', () => {
	try {
		rimraf.sync(testDataPath);
	} catch {
		// noop
	}
});

const testRepoUrl = 'https://github.com/microsoft/vscode-smoketest-express';
const workspacePath = path.join(testDataPath, 'vscode-smoketest-express');
const extensionsPath = path.join(testDataPath, 'extensions-dir');
mkdirp.sync(extensionsPath);

function fail(errorMessage): void {
	logger.log(errorMessage);
	if (!opts.verbose) {
		console.error(errorMessage);
	}
	process.exit(1);
}

let quality: Quality;
let version: string | undefined;

function parseVersion(version: string): { major: number; minor: number; patch: number } {
	const [, major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(version)!;
	return { major: parseInt(major), minor: parseInt(minor), patch: parseInt(patch) };
}

//
// #### Electron Smoke Tests ####
//
if (!opts.web) {
	let testCodePath = opts.build;
	let electronPath: string;

	if (testCodePath) {
		electronPath = getBuildElectronPath(testCodePath);
		version = getBuildVersion(testCodePath);
	} else {
		testCodePath = getDevElectronPath();
		electronPath = testCodePath;
		process.env.VSCODE_REPOSITORY = rootPath;
		process.env.VSCODE_DEV = '1';
		process.env.VSCODE_CLI = '1';
	}

	if (!fs.existsSync(electronPath || '')) {
		fail(`Can't find VSCode at ${electronPath}. Please run VSCode once first (scripts/code.sh, scripts\\code.bat) and try again.`);
	}

	if (process.env.VSCODE_DEV === '1') {
		quality = Quality.Dev;
	} else if (electronPath.indexOf('Code - Insiders') >= 0 /* macOS/Windows */ || electronPath.indexOf('code-insiders') /* Linux */ >= 0) {
		quality = Quality.Insiders;
	} else {
		quality = Quality.Stable;
	}

	if (opts.remote) {
		logger.log(`Running desktop remote smoke tests against ${electronPath}`);
	} else {
		logger.log(`Running desktop smoke tests against ${electronPath}`);
	}
}

//
// #### Web Smoke Tests ####
//
else {
	const testCodeServerPath = opts.build || process.env.VSCODE_REMOTE_SERVER_PATH;

	if (typeof testCodeServerPath === 'string') {
		if (!fs.existsSync(testCodeServerPath)) {
			fail(`Can't find Code server at ${testCodeServerPath}.`);
		} else {
			logger.log(`Running web smoke tests against ${testCodeServerPath}`);
		}
	}

	if (!testCodeServerPath) {
		process.env.VSCODE_REPOSITORY = rootPath;
		process.env.VSCODE_DEV = '1';
		process.env.VSCODE_CLI = '1';

		logger.log(`Running web smoke out of sources`);
	}

	if (process.env.VSCODE_DEV === '1') {
		quality = Quality.Dev;
	} else {
		quality = Quality.Insiders;
	}
}

const userDataDir = path.join(testDataPath, 'd');

async function setupRepository(): Promise<void> {
	if (opts['test-repo']) {
		logger.log('Copying test project repository:', opts['test-repo']);
		rimraf.sync(workspacePath);
		// not platform friendly
		if (process.platform === 'win32') {
			cp.execSync(`xcopy /E "${opts['test-repo']}" "${workspacePath}"\\*`);
		} else {
			cp.execSync(`cp -R "${opts['test-repo']}" "${workspacePath}"`);
		}
	} else {
		if (!fs.existsSync(workspacePath)) {
			logger.log('Cloning test project repository...');
			cp.spawnSync('git', ['clone', testRepoUrl, workspacePath]);
		} else {
			logger.log('Cleaning test project repository...');
			cp.spawnSync('git', ['fetch'], { cwd: workspacePath });
			cp.spawnSync('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: workspacePath });
			cp.spawnSync('git', ['clean', '-xdf'], { cwd: workspacePath });
		}

		// None of the current smoke tests have a dependency on the packages.
		// If new smoke tests are added that need the packages, uncomment this.
		// logger.log('Running yarn...');
		// cp.execSync('yarn', { cwd: workspacePath, stdio: 'inherit' });
	}
}

async function ensureStableCode(): Promise<void> {
	let stableCodePath = opts['stable-build'];
	if (!stableCodePath) {
		const { major, minor } = parseVersion(version!);
		const majorMinorVersion = `${major}.${minor - 1}`;
		const versionsReq = await retry(() => measureAndLog(fetch('https://update.code.visualstudio.com/api/releases/stable', { headers: { 'x-api-version': '2' } }), 'versionReq', logger), 1000, 20);

		if (!versionsReq.ok) {
			throw new Error('Could not fetch releases from update server');
		}

		const versions: { version: string }[] = await measureAndLog(versionsReq.json(), 'versionReq.json()', logger);
		const prefix = `${majorMinorVersion}.`;
		const previousVersion = versions.find(v => v.version.startsWith(prefix));

		if (!previousVersion) {
			throw new Error(`Could not find suitable stable version ${majorMinorVersion}`);
		}

		logger.log(`Found VS Code v${version}, downloading previous VS Code version ${previousVersion.version}...`);

		let lastProgressMessage: string | undefined = undefined;
		let lastProgressReportedAt = 0;
		const stableCodeDestination = path.join(testDataPath, 's');
		const stableCodeExecutable = await retry(() => measureAndLog(vscodetest.download({
			cachePath: stableCodeDestination,
			version: previousVersion.version,
			extractSync: true,
			reporter: {
				report: report => {
					let progressMessage = `download stable code progress: ${report.stage}`;
					const now = Date.now();
					if (progressMessage !== lastProgressMessage || now - lastProgressReportedAt > 10000) {
						lastProgressMessage = progressMessage;
						lastProgressReportedAt = now;

						if (report.stage === 'downloading') {
							progressMessage += ` (${report.bytesSoFar}/${report.totalBytes})`;
						}

						logger.log(progressMessage);
					}
				},
				error: error => logger.log(`download stable code error: ${error}`)
			}
		}), 'download stable code', logger), 1000, 3, () => new Promise<void>((resolve, reject) => {
			rimraf(stableCodeDestination, { maxBusyTries: 10 }, error => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		}));

		if (process.platform === 'darwin') {
			// Visual Studio Code.app/Contents/MacOS/Electron
			stableCodePath = path.dirname(path.dirname(path.dirname(stableCodeExecutable)));
		} else {
			// VSCode/Code.exe (Windows) | VSCode/code (Linux)
			stableCodePath = path.dirname(stableCodeExecutable);
		}
	}

	if (!fs.existsSync(stableCodePath)) {
		throw new Error(`Can't find Stable VSCode at ${stableCodePath}.`);
	}

	logger.log(`Using stable build ${stableCodePath} for migration tests`);

	opts['stable-build'] = stableCodePath;
}

async function setup(): Promise<void> {
	logger.log('Test data path:', testDataPath);
	logger.log('Preparing smoketest setup...');

	if (!opts.web && !opts.remote && opts.build) {
		// only enabled when running with --build and not in web or remote
		await measureAndLog(ensureStableCode(), 'ensureStableCode', logger);
	}
	await measureAndLog(setupRepository(), 'setupRepository', logger);

	logger.log('Smoketest setup done!\n');
}

// Before main suite (before all tests)
before(async function () {
	this.timeout(5 * 60 * 1000); // increase since we download VSCode

	this.defaultOptions = {
		quality,
		codePath: opts.build,
		workspacePath,
		userDataDir,
		extensionsPath,
		waitTime: parseInt(opts['wait-time'] || '0') || 20,
		logger,
		logsPath,
		verbose: opts.verbose,
		remote: opts.remote,
		web: opts.web,
		legacy: opts.legacy,
		tracing: opts.tracing,
		headless: opts.headless,
		browser: opts.browser,
		extraArgs: (opts.electronArgs || '').split(' ').map(a => a.trim()).filter(a => !!a)
	};

	await setup();
});

// After main suite (after all tests)
after(async function () {
	try {
		let deleted = false;
		await measureAndLog(Promise.race([
			new Promise<void>((resolve, reject) => rimraf(testDataPath, { maxBusyTries: 10 }, error => {
				if (error) {
					reject(error);
				} else {
					deleted = true;
					resolve();
				}
			})),
			timeout(30000).then(() => {
				if (!deleted) {
					throw new Error('giving up after 30s');
				}
			})
		]), 'rimraf(testDataPath)', logger);
	} catch (error) {
		logger.log(`Unable to delete smoke test workspace: ${error}. This indicates some process is locking the workspace folder.`);
	}
});

describe(`VSCode Smoke Tests (${opts.web ? 'Web' : opts.legacy ? 'Electron (legacy)' : 'Electron'})`, () => {
	if (!opts.web) { setupDataLossTests(() => opts['stable-build'] /* Do not change, deferred for a reason! */, logger); }
	setupPreferencesTests(logger);
	setupSearchTests(logger);
	setupNotebookTests(logger);
	setupLanguagesTests(logger);
	if (opts.web) { setupTerminalTests(logger); } // Tests require playwright driver (https://github.com/microsoft/vscode/issues/146811)
	setupStatusbarTests(logger);
	if (quality !== Quality.Dev) { setupExtensionTests(logger); }
	setupMultirootTests(logger);
	if (!opts.web && !opts.remote && quality !== Quality.Dev) { setupLocalizationTests(logger); }
	if (!opts.web && !opts.remote) { setupLaunchTests(logger); }
});
