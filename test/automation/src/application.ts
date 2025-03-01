/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Workbench } from './workbench';
import { Code, launch, LaunchOptions } from './code';
import { Logger, measureAndLog } from './logger';
import { PlaywrightDriver } from './playwrightBrowserDriver';

export const enum Quality {
	Dev,
	Insiders,
	Stable
}

export interface ApplicationOptions extends LaunchOptions {
	quality: Quality;
	workspacePath: string;
	waitTime: number;
}

export class Application {

	private static INSTANCES = 0;

	constructor(private options: ApplicationOptions) {
		Application.INSTANCES++;

		this._userDataPath = options.userDataDir;
		this._workspacePathOrFolder = options.workspacePath;
	}

	private _code: Code | undefined;
	get code(): Code { return this._code!; }

	private _workbench: Workbench | undefined;
	get workbench(): Workbench { return this._workbench!; }

	get quality(): Quality {
		return this.options.quality;
	}

	get logger(): Logger {
		return this.options.logger;
	}

	get remote(): boolean {
		return !!this.options.remote;
	}

	get web(): boolean {
		return !!this.options.web;
	}

	get legacy(): boolean {
		return !!this.options.legacy;
	}

	private _workspacePathOrFolder: string;
	get workspacePathOrFolder(): string {
		return this._workspacePathOrFolder;
	}

	get extensionsPath(): string {
		return this.options.extensionsPath;
	}

	private _userDataPath: string;
	get userDataPath(): string {
		return this._userDataPath;
	}

	async start(): Promise<void> {
		await this._start();
		await this.code.waitForElement('.explorer-folders-view');
	}

	async restart(options?: { workspaceOrFolder?: string; extraArgs?: string[] }): Promise<void> {
		await this.stop();
		await this._start(options?.workspaceOrFolder, options?.extraArgs);
	}

	private async _start(workspaceOrFolder = this.workspacePathOrFolder, extraArgs: string[] = []): Promise<void> {
		this._workspacePathOrFolder = workspaceOrFolder;

		// Launch Code...
		const code = await this.startApplication(extraArgs);

		// ...and make sure the window is ready to interact
		const windowReady = measureAndLog(this.checkWindowReady(code), 'Application#checkWindowReady()', this.logger);

		// Make sure to take a screenshot if waiting for window ready
		// takes unusually long to help diagnose issues when Code does
		// not seem to startup healthy.
		const timeoutHandle = setTimeout(() => this.takeScreenshot(`checkWindowReady_instance_${Application.INSTANCES}`), 10000);
		try {
			await windowReady;
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	async stop(): Promise<void> {
		if (this._code) {
			try {
				await this._code.exit();
			} finally {
				this._code = undefined;
			}
		}
	}

	async startTracing(name: string): Promise<void> {
		await this._code?.startTracing(name);
	}

	async stopTracing(name: string, persist: boolean): Promise<void> {
		await this._code?.stopTracing(name, persist);
	}

	private async takeScreenshot(name: string): Promise<void> {
		const driver = this._code?.driver;
		if (!(driver instanceof PlaywrightDriver)) {
			return;
		}

		await driver.takeScreenshot(name);
	}

	private async startApplication(extraArgs: string[] = []): Promise<Code> {
		const code = this._code = await launch({
			...this.options,
			extraArgs: [...(this.options.extraArgs || []), ...extraArgs],
		});

		this._workbench = new Workbench(this._code, this.userDataPath);

		return code;
	}

	private async checkWindowReady(code: Code): Promise<void> {

		// This is legacy and will be removed when our old driver removes
		await code.waitForWindowIds(ids => ids.length > 0);

		// We need a rendered workbench
		await measureAndLog(code.waitForElement('.monaco-workbench', undefined, 300 /* 30s of retry */), 'Application#checkWindowReady: wait for .monaco-workbench element', this.logger);

		// Remote but not web: wait for a remote connection state change
		if (this.remote) {
			await measureAndLog(code.waitForTextContent('.monaco-workbench .statusbar-item[id="status.host"]', undefined, s => {
				this.logger.log(`checkWindowReady: remote indicator text is ${s}`);

				// The absence of "Opening Remote" is not a strict
				// indicator for a successful connection, but we
				// want to avoid hanging here until timeout because
				// this method is potentially called from a location
				// that has no tracing enabled making it hard to
				// diagnose this. As such, as soon as the connection
				// state changes away from the "Opening Remote..." one
				// we return.
				return !s.includes('Opening Remote');
			}, 300 /* = 30s of retry */), 'Application#checkWindowReady: wait for remote indicator', this.logger);
		}
	}
}
