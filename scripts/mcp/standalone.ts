/**
 * The Claude plugin's server (docs/plugin.md): one process that is the MCP server Claude Code
 * starts (stdio, `main.ts`), serves the built app to the browser, bridges to the tabs that load
 * it, and keeps one model file of the repository in step with the tab: read on `aster_open`,
 * written after every change, re-read when something else changes it.
 */
import type { Server } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Hello, OpenFileResult, Save, Saved } from '#lib/bridge/protocol.ts';
import { Broker } from './broker.ts';
import { DiskFile, FileError } from './files.ts';
import { createBridgeHttp } from './http.ts';
import { createMcpServer, failed, json } from './server.ts';

export const DEFAULT_PORT = 4517;
const PORT_TRIES = 20;

export const INSTRUCTIONS = `Aster is a UML class modeller that runs in a browser tab; these tools read and edit the model the tab shows, and the tab's user edits the same model by hand. Model files (.mdj, StarUML's format, or .aster) live in the repository and are the single source of truth.

To work on a model file: call aster_open with its path (relative to the repository) and the diagram to show. It answers with a URL; when no tab is connected yet, open that URL in the browser (the built-in browser pane when there is one), then call aster_status. Every change, yours or the user's, is written back to the file within a second, so git sees it: review with git diff, commit when the user asks.

Read before writing (aster_get_text, aster_status), prefer aster_set_text for larger edits and the dedicated tools for small ones, and call aster_changes_since or aster_status before a write when the user may have edited in between. Every write is one undo step in the tab.`;

export interface PluginServerOptions {
	/** The repository: model files open inside it only. */
	root: string;
	/** The built app. */
	appDir: string;
	timeoutMs?: number;
	pollMs?: number;
	log?: (line: string) => void;
}

export interface PluginServer {
	broker: Broker;
	disk: DiskFile;
	http: Server;
	mcp: McpServer;
	/** Starts the HTTP side on the first free port from `port`; resolves to the app's URL. */
	listen(port?: number): Promise<string>;
	url(): string;
	close(): Promise<void>;
}

export function createPluginServer(opts: PluginServerOptions): PluginServer {
	const log = opts.log ?? (() => {});
	const broker = new Broker(opts.timeoutMs ?? 30_000);
	const disk = new DiskFile(opts.root, opts.pollMs);
	let port = 0;
	const url = () => `http://127.0.0.1:${port}/`;
	broker.noTabHint =
		'Call aster_open with a model file, then open the URL it gives in the browser.';

	// The tabs that were sent the open file. A tab the user then points elsewhere is left alone;
	// a reloaded tab is a new one and gets the file again.
	let shown = new WeakSet<object>();
	// While a tab is being sent the file, what it saves was made from the text before: refused.
	let showing = 0;
	const show = (): Promise<OpenFileResult> => {
		const params = disk.params;
		const tab = broker.active;
		if (!params || !tab) return Promise.reject(new Error('No file or no tab.'));
		shown.add(tab.key);
		showing++;
		return broker.request('open_file', params).finally(() => showing--);
	};
	const quietly = (what: string) => (e: unknown) =>
		log(`${what}: ${e instanceof Error ? e.message : String(e)}`);

	disk.onOutside = (p) => {
		log(`${p.path} changed on disk`);
		if (broker.active) show().catch(quietly('reload'));
	};
	const onHello = (key: object, hello: Hello) => {
		if (disk.path && hello.file !== disk.path && !shown.has(key))
			show().catch(quietly(`open ${disk.path}`));
	};
	const onSave = (s: Save): Saved => {
		try {
			if (showing) throw new FileError('stale', `${s.path} is being reloaded in the tab.`);
			disk.write(s.path, s.text);
			return { path: s.path, version: s.version, ok: true };
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			log(`save ${s.path}: ${error}`);
			return { path: s.path, version: s.version, ok: false, error };
		}
	};

	const http = createBridgeHttp({ appDir: opts.appDir, broker, onHello, onSave });
	const mcp = createMcpServer(broker, INSTRUCTIONS);

	mcp.registerTool(
		'aster_open',
		{
			title: 'Aster: open a model file',
			description:
				"Opens a model file of the repository (.mdj, .aster or .aster.json; a path relative to the repository) in the Aster tab and shows one of its diagrams. A file that does not exist yet becomes a new, empty project with one diagram of that name, and is created on disk. From then on every change in the tab, yours or the user's, is written to the file within a second, and a change to the file from outside (git checkout, pull) reloads the tab. Answers with the URL of the tab: when none is connected, open that URL in the browser (the built-in browser pane when there is one) and call aster_status; the tab loads the file as it connects. Opening another file replaces this one in the tab.",
			inputSchema: {
				file: z.string().describe('Path of the model file, relative to the repository.'),
				diagram: z
					.string()
					.optional()
					.describe(
						'The diagram (view) to show, by name or id. Omit for the one the file opens with.'
					)
			}
		},
		async ({ file, diagram }) => {
			try {
				const p = disk.open(file, diagram);
				shown = new WeakSet();
				const exists = p.text !== null;
				if (!broker.active)
					return json({
						file: p.path,
						exists,
						connected: false,
						url: url(),
						next: `No Aster tab is connected. Open ${url()} in the browser, then call aster_status: the tab loads ${p.path} as it connects${exists ? '' : ' (a new, empty project; the file is created then)'}.`
					});
				const r = await show();
				return json({
					file: p.path,
					connected: true,
					...r,
					...(!r.diagramFound && {
						note: `No diagram is named ${diagram}; ${r.diagram} shows instead. Make one with aster_add_diagram (open: true).`
					})
				});
			} catch (e) {
				return failed(e instanceof FileError ? new Error(`${e.code}: ${e.message}`) : e);
			}
		}
	);

	return {
		broker,
		disk,
		http,
		mcp,
		url,
		listen: async (from = DEFAULT_PORT) => {
			for (let p = from; ; p++) {
				try {
					await new Promise<void>((resolve, reject) => {
						http.once('error', reject);
						http.listen(p, '127.0.0.1', () => {
							http.off('error', reject);
							resolve();
						});
					});
					break;
				} catch (e) {
					const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
					if (!busy || from === 0 || p - from >= PORT_TRIES) throw e;
				}
			}
			const address = http.address();
			port = typeof address === 'object' && address ? address.port : from;
			return url();
		},
		close: async () => {
			disk.close();
			await mcp.close();
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		}
	};
}
