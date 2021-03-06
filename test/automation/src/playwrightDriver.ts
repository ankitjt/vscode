/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as playwright from 'playwright';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { mkdir } from 'fs';
import { promisify } from 'util';
import { IDriver, IDisposable } from './driver';
import { URI } from 'vscode-uri';

const width = 1200;
const height = 800;

const vscodeToPlaywrightKey: { [key: string]: string } = {
	cmd: 'Meta',
	ctrl: 'Control',
	shift: 'Shift',
	enter: 'Enter',
	escape: 'Escape',
	right: 'ArrowRight',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	home: 'Home'
};

function buildDriver(browser: playwright.Browser, page: playwright.Page): IDriver {
	const driver: IDriver = {
		_serviceBrand: undefined,
		getWindowIds: () => {
			return Promise.resolve([1]);
		},
		capturePage: () => Promise.resolve(''),
		reloadWindow: (windowId) => Promise.resolve(),
		exitApplication: () => browser.close(),
		dispatchKeybinding: async (windowId, keybinding) => {
			const chords = keybinding.split(' ');
			for (let i = 0; i < chords.length; i++) {
				const chord = chords[i];
				if (i > 0) {
					await timeout(100);
				}
				const keys = chord.split('+');
				const keysDown: string[] = [];
				for (let i = 0; i < keys.length; i++) {
					if (keys[i] in vscodeToPlaywrightKey) {
						keys[i] = vscodeToPlaywrightKey[keys[i]];
					}
					await page.keyboard.down(keys[i]);
					keysDown.push(keys[i]);
				}
				while (keysDown.length > 0) {
					await page.keyboard.up(keysDown.pop()!);
				}
			}

			await timeout(100);
		},
		click: async (windowId, selector, xoffset, yoffset) => {
			const { x, y } = await driver.getElementXY(windowId, selector, xoffset, yoffset);
			await page.mouse.click(x + (xoffset ? xoffset : 0), y + (yoffset ? yoffset : 0));
		},
		doubleClick: async (windowId, selector) => {
			await driver.click(windowId, selector, 0, 0);
			await timeout(60);
			await driver.click(windowId, selector, 0, 0);
			await timeout(100);
		},
		setValue: async (windowId, selector, text) => page.evaluate(`window.driver.setValue('${selector}', '${text}')`).then(undefined),
		getTitle: (windowId) => page.evaluate(`window.driver.getTitle()`),
		isActiveElement: (windowId, selector) => page.evaluate(`window.driver.isActiveElement('${selector}')`),
		getElements: (windowId, selector, recursive) => page.evaluate(`window.driver.getElements('${selector}', ${recursive})`),
		getElementXY: (windowId, selector, xoffset?, yoffset?) => page.evaluate(`window.driver.getElementXY('${selector}', ${xoffset}, ${yoffset})`),
		typeInEditor: (windowId, selector, text) => page.evaluate(`window.driver.typeInEditor('${selector}', '${text}')`),
		getTerminalBuffer: (windowId, selector) => page.evaluate(`window.driver.getTerminalBuffer('${selector}')`),
		writeInTerminal: (windowId, selector, text) => page.evaluate(`window.driver.writeInTerminal('${selector}', '${text}')`)
	};
	return driver;
}

function timeout(ms: number): Promise<void> {
	return new Promise<void>(r => setTimeout(r, ms));
}

// function runInDriver(call: string, args: (string | boolean)[]): Promise<any> {}

let server: ChildProcess | undefined;
let endpoint: string | undefined;
let workspacePath: string | undefined;

export async function launch(userDataDir: string, _workspacePath: string, codeServerPath = process.env.VSCODE_REMOTE_SERVER_PATH): Promise<void> {
	workspacePath = _workspacePath;
	const agentFolder = userDataDir;
	await promisify(mkdir)(agentFolder);
	const env = {
		VSCODE_AGENT_FOLDER: agentFolder,
		VSCODE_REMOTE_SERVER_PATH: codeServerPath,
		...process.env
	};
	let serverLocation: string | undefined;
	if (codeServerPath) {
		serverLocation = join(codeServerPath, `server.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
	} else {
		serverLocation = join(__dirname, '..', '..', '..', `resources/server/web.${process.platform === 'win32' ? 'bat' : 'sh'}`);
	}
	server = spawn(
		serverLocation,
		['--browser', 'none', '--driver', 'web'],
		{ env }
	);
	server.stderr?.on('data', e => console.log('Server stderr: ' + e));
	server.stdout?.on('data', e => console.log('Server stdout: ' + e));
	process.on('exit', teardown);
	process.on('SIGINT', teardown);
	process.on('SIGTERM', teardown);
	endpoint = await waitForEndpoint();
}

function teardown(): void {
	if (server) {
		server.kill();
		server = undefined;
	}
}

function waitForEndpoint(): Promise<string> {
	return new Promise<string>(r => {
		server!.stdout?.on('data', (d: Buffer) => {
			const matches = d.toString('ascii').match(/Web UI available at (.+)/);
			if (matches !== null) {
				r(matches[1]);
			}
		});
	});
}

export function connect(headless: boolean, engine: 'chromium' | 'webkit' | 'firefox' = 'chromium'): Promise<{ client: IDisposable, driver: IDriver }> {
	return new Promise(async (c) => {
		const browser = await playwright[engine].launch({
			// Run in Edge dev on macOS
			// executablePath: '/Applications/Microsoft\ Edge\ Dev.app/Contents/MacOS/Microsoft\ Edge\ Dev',
			headless
		});
		const page = (await browser.defaultContext().pages())[0];
		await page.setViewport({ width, height });
		await page.goto(`${endpoint}&folder=vscode-remote://localhost:9888${URI.file(workspacePath!).path}`);
		const result = {
			client: { dispose: () => teardown() },
			driver: buildDriver(browser, page)
		};
		c(result);
	});
}
