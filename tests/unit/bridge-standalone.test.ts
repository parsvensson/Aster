import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle, modelRects, type Context } from '#lib/bridge/handle.ts';
import type {
	BridgeRequest,
	Hello,
	OpenFileParams,
	OpenFileResult,
	Saved
} from '#lib/bridge/protocol.ts';
import { isLocalHost } from '#lib/bridge/http.ts';
import { Stack, batch } from '#lib/commands/index.ts';
import { sampleProject } from '#lib/model/fixtures.ts';
import { DiskFile, FileError } from '../../scripts/mcp/files.ts';
import { staticFile } from '../../scripts/mcp/http.ts';
import { sameOrigin } from '../../scripts/mcp/local.ts';
import { createPluginServer, type PluginServer } from '../../scripts/mcp/standalone.ts';

/**
 * The Claude plugin's server (docs/plugin.md), whole: an MCP client on one side, a tab speaking
 * the HTTP channel on the other (answering with the real handler), a folder of files underneath.
 */

const until = async (test: () => boolean, what: string, ms = 3000) => {
	const t0 = Date.now();
	while (!test()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};

/** A tab: the event stream and the POSTs of src/lib/bridge/http.ts, from Node. */
class HttpTab {
	id = randomUUID();
	project = sampleProject();
	stack = new Stack(() => this.project);
	version = 0;
	/** The server's file this tab shows, as `open_file` left it. */
	file: string | null = null;
	opened: OpenFileParams[] = [];
	saved: Saved[] = [];
	events: string[] = [];
	#abort = new AbortController();
	constructor(readonly base: string) {}

	get hello(): Hello {
		return {
			projectId: this.project.id,
			project: this.project.name,
			diagramId: 'd1',
			diagram: 'Main',
			route: 'sample',
			url: `${this.base}design/sample`,
			version: this.version,
			file: this.file
		};
	}
	get ctx(): Context {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		return {
			project: this.project,
			get version() {
				return self.version;
			},
			activeDiagramId: 'd1',
			rects: (d) => modelRects(self.project, d),
			run: (plan) => {
				const label = self.stack.run(batch(self.project, plan));
				self.version++;
				void self
					.send('aster:changed', { version: self.version, label, diagramId: 'd1' })
					.catch(() => {});
				return label;
			},
			ui: () => ({
				file: null,
				state: 'new',
				editor: true,
				route: 'sample',
				url: self.hello.url,
				selection: [],
				editing: false,
				undoLabel: self.stack.undoLabel,
				redoLabel: self.stack.redoLabel
			}),
			openFile: async (p): Promise<OpenFileResult> => {
				self.opened.push(p);
				self.file = p.path;
				return {
					project: self.project.name,
					created: p.text === null,
					diagramId: 'd1',
					diagram: 'Main',
					diagramFound: !p.diagram || p.diagram === 'Main',
					diagrams: [],
					route: 'sample',
					url: self.hello.url,
					version: self.version
				};
			}
		};
	}
	async connect() {
		const res = await fetch(`${this.base}__bridge/events?tab=${this.id}`, {
			signal: this.#abort.signal
		});
		expect(res.status).toBe(200);
		const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = '';
		void (async () => {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					buffer += value;
					let cut: number;
					while ((cut = buffer.indexOf('\n\n')) >= 0) {
						const line = buffer.slice(0, cut);
						buffer = buffer.slice(cut + 2);
						if (line.startsWith('data: ')) this.#on(JSON.parse(line.slice(6)));
					}
				}
			} catch {
				// closed
			}
		})();
		await until(() => this.events.includes('aster:who'), 'the server to ask who is there');
	}
	#on(msg: { event: string; payload?: unknown }) {
		this.events.push(msg.event);
		if (msg.event === 'aster:who') void this.send('aster:hello', this.hello).catch(() => {});
		if (msg.event === 'aster:saved') this.saved.push(msg.payload as Saved);
		if (msg.event === 'aster:req')
			void handle(msg.payload as BridgeRequest, this.ctx)
				.then((r) => this.send('aster:res', r))
				.catch(() => {});
	}
	send(event: string, payload: unknown) {
		return fetch(`${this.base}__bridge/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tab: this.id, event, payload })
		});
	}
	close() {
		this.#abort.abort();
	}
}

const textOf = (r: CallToolResult) =>
	r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');

describe('the plugin server', () => {
	let server: PluginServer;
	let base: string;
	let client: Client;
	let root: string;
	const tabs: HttpTab[] = [];
	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;
	const tab = async () => {
		const t = new HttpTab(base);
		tabs.push(t);
		await t.connect();
		await until(
			() => server.broker.tabs.some((b) => b.hello.url === t.hello.url),
			'the tab to say hello'
		);
		return t;
	};

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), 'aster-plugin-root-'));
		const appDir = mkdtempSync(join(tmpdir(), 'aster-plugin-app-'));
		writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>welcome</title>');
		writeFileSync(join(appDir, '404.html'), '<!doctype html><title>shell</title>');
		writeFileSync(join(appDir, 'projects.html'), '<!doctype html><title>projects</title>');
		mkdirSync(join(appDir, '_app/immutable'), { recursive: true });
		writeFileSync(join(appDir, '_app/immutable/a.js'), 'export {}');
		writeFileSync(join(appDir, 'service-worker.js'), 'caches.open("x")');
		writeFileSync(join(root, '..', 'secret.mdj'), '{}');
		mkdirSync(join(root, 'docs'));
		writeFileSync(join(root, 'docs/model.mdj'), '{"_type":"Project","name":"One"}');

		server = // The watcher is looked at by hand here (disk.check), so each test decides the order of events.
			server = createPluginServer({ root, appDir, timeoutMs: 3000, pollMs: 60_000 });
		base = await server.listen(0);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.mcp.connect(a);
		client = new Client({ name: 'test', version: '0' });
		await client.connect(b);
	});
	afterAll(async () => {
		for (const t of tabs) t.close();
		await client.close();
		await server.close();
	});

	it('serves the built app: pages, the editor shell for unknown paths, files as they are', async () => {
		const get = async (path: string) => {
			const r = await fetch(new URL(path, base));
			return { status: r.status, type: r.headers.get('content-type'), body: await r.text() };
		};
		expect((await get('/')).body).toContain('welcome');
		expect((await get('/projects')).body).toContain('projects');
		expect(await get('/design/library')).toMatchObject({
			status: 200,
			type: 'text/html; charset=utf-8'
		});
		expect((await get('/design/library')).body).toContain('shell');
		expect((await get('/_app/immutable/a.js')).type).toBe('text/javascript; charset=utf-8');
		// No offline cache: a worker that handles nothing stands in for the app's own.
		expect((await get('/service-worker.js')).body).not.toContain('caches');
		expect((await fetch(new URL('/', base), { method: 'POST' })).status).toBe(405);
	});

	it('never serves a file outside the app', () => {
		const appDir = mkdtempSync(join(tmpdir(), 'aster-static-'));
		writeFileSync(join(appDir, 'a.txt'), 'a');
		writeFileSync(join(appDir, '..', 'outside.txt'), 'no');
		expect(staticFile(appDir, '/a.txt')).toBe(join(appDir, 'a.txt'));
		expect(staticFile(appDir, '/../outside.txt')).toBeNull();
		expect(staticFile(appDir, '/%2e%2e/outside.txt')).toBeNull();
		expect(staticFile(appDir, '/%')).toBeNull();
		expect(staticFile(appDir, '/missing')).toBeNull();
	});

	it('answers its own pages only: another site in the same browser is refused', async () => {
		expect(sameOrigin({ headers: { host: '127.0.0.1:4517' } })).toBe(true);
		expect(
			sameOrigin({ headers: { host: '127.0.0.1:4517', origin: 'http://127.0.0.1:4517' } })
		).toBe(true);
		expect(
			sameOrigin({ headers: { host: '127.0.0.1:4517', origin: 'https://evil.example' } })
		).toBe(false);
		const ping = await fetch(new URL('/__bridge/ping', base));
		expect(await ping.json()).toEqual({ aster: true });
		const foreign = await fetch(new URL('/__bridge/ping', base), {
			headers: { origin: 'https://evil.example' }
		});
		expect(foreign.status).toBe(403);
		const noStream = await fetch(new URL('/__bridge/send', base), {
			method: 'POST',
			body: JSON.stringify({ tab: 'nobody-here', event: 'aster:hello', payload: {} })
		});
		expect(noStream.status).toBe(409);
	});

	it('has 30 tools, aster_open among them, and says how to work', async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain('aster_open');
		expect(tools).toHaveLength(30);
		expect(client.getInstructions()).toContain('aster_open');
	});

	it('without a tab, aster_open reads the file and says where to open one', async () => {
		const r = JSON.parse(textOf(await call('aster_open', { file: 'docs/model.mdj' })));
		expect(r).toMatchObject({ file: 'docs/model.mdj', exists: true, connected: false, url: base });
		const status = await call('aster_status');
		expect(status.isError).toBe(true);
		expect(textOf(status)).toContain('aster_open');
	});

	it('a tab that connects is sent the open file, once', async () => {
		const t = await tab();
		await until(() => t.opened.length === 1, 'the file to arrive');
		expect(t.opened[0]).toEqual({
			path: 'docs/model.mdj',
			name: 'model.mdj',
			text: '{"_type":"Project","name":"One"}',
			diagram: undefined
		});
		// It says hello again (focus), now showing something else by the user's own hand: left alone.
		t.file = null;
		await t.send('aster:hello', t.hello);
		await new Promise((r) => setTimeout(r, 60));
		expect(t.opened).toHaveLength(1);
		// The other tools reach the same tab.
		expect(JSON.parse(textOf(await call('aster_status'))).project.name).toBe(t.project.name);
	});

	it('writes what the tab saves, whole, and says so', async () => {
		const t = tabs[0];
		await t.send('aster:save', { path: 'docs/model.mdj', text: '{"name":"Two"}', version: 7 });
		await until(() => t.saved.length === 1, 'the answer to the save');
		expect(t.saved[0]).toEqual({ path: 'docs/model.mdj', version: 7, ok: true });
		expect(readFileSync(join(root, 'docs/model.mdj'), 'utf8')).toBe('{"name":"Two"}');
		// Its own write is not an outside change.
		expect(server.disk.check()).toBe(false);
		expect(t.opened).toHaveLength(1);
		// A save for a file that is not the open one is refused.
		await t.send('aster:save', { path: 'other.mdj', text: 'x', version: 8 });
		await until(() => t.saved.length === 2, 'the refusal');
		expect(t.saved[1]).toMatchObject({ ok: false });
		expect(existsSync(join(root, 'other.mdj'))).toBe(false);
	});

	it('a change from outside (git) reloads the tab, and a save that raced it is refused', async () => {
		const t = tabs[0];
		writeFileSync(join(root, 'docs/model.mdj'), '{"name":"From git"}');
		// The tab saves before the watcher has looked: the disk wins.
		await t.send('aster:save', { path: 'docs/model.mdj', text: '{"name":"Mine"}', version: 9 });
		await until(() => t.saved.length === 3, 'the refusal');
		expect(t.saved[2]).toMatchObject({ ok: false, version: 9 });
		await until(() => t.opened.length === 2, 'the reload');
		expect(t.opened[1].text).toBe('{"name":"From git"}');
		expect(readFileSync(join(root, 'docs/model.mdj'), 'utf8')).toBe('{"name":"From git"}');
		// And without a save: the watcher's look alone.
		writeFileSync(join(root, 'docs/model.mdj'), '{"name":"Pulled"}');
		expect(server.disk.check()).toBe(true);
		await until(() => t.opened.length === 3, 'the reload');
		expect(t.opened[2].text).toBe('{"name":"Pulled"}');
	});

	it('opens a file that does not exist yet as a new project, created by its first save', async () => {
		const t = tabs[0];
		const r = JSON.parse(
			textOf(await call('aster_open', { file: 'design/new/alpha.mdj', diagram: 'alpha' }))
		);
		expect(r).toMatchObject({ file: 'design/new/alpha.mdj', connected: true, created: true });
		expect(r.note).toContain('aster_add_diagram');
		expect(t.opened.at(-1)).toEqual({
			path: 'design/new/alpha.mdj',
			name: 'alpha.mdj',
			text: null,
			diagram: 'alpha'
		});
		expect(existsSync(join(root, 'design/new/alpha.mdj'))).toBe(false);
		await t.send('aster:save', { path: 'design/new/alpha.mdj', text: '{"new":true}', version: 1 });
		await until(() => t.saved.at(-1)?.path === 'design/new/alpha.mdj', 'the first save');
		expect(readFileSync(join(root, 'design/new/alpha.mdj'), 'utf8')).toBe('{"new":true}');
	});

	it('a reloaded tab (a new one) gets the open file again', async () => {
		const t = await tab();
		await until(() => t.opened.length === 1, 'the file to arrive');
		expect(t.opened[0].path).toBe('design/new/alpha.mdj');
		expect(t.opened[0].text).toBe('{"new":true}');
	});

	it('refuses files outside the repository and files that are not models', async () => {
		const outside = await call('aster_open', { file: '../secret.mdj' });
		expect(outside.isError).toBe(true);
		expect(textOf(outside)).toContain('outside');
		const absolute = await call('aster_open', { file: join(root, '..', 'secret.mdj') });
		expect(absolute.isError).toBe(true);
		const readme = await call('aster_open', { file: 'README.md' });
		expect(readme.isError).toBe(true);
		expect(textOf(readme)).toContain('format');
		// The file that was open stays open.
		expect(server.disk.path).toBe('design/new/alpha.mdj');
	});
});

describe('the tab', () => {
	it('looks for a bridge on this computer only, never on the public site', () => {
		for (const host of ['localhost', '127.0.0.1', '[::1]', 'aster.localhost'])
			expect(isLocalHost(host)).toBe(true);
		for (const host of ['asteruml.app', 'localhost.evil.example', '192.168.1.7'])
			expect(isLocalHost(host)).toBe(false);
	});
});

describe('the file on disk', () => {
	it('watches the open file', async () => {
		const root = mkdtempSync(join(tmpdir(), 'aster-watch-'));
		writeFileSync(join(root, 'm.mdj'), 'one');
		const disk = new DiskFile(root, 20);
		const outside: (string | null)[] = [];
		disk.onOutside = (p) => outside.push(p.text);
		disk.open('m.mdj');
		await new Promise((r) => setTimeout(r, 50));
		writeFileSync(join(root, 'm.mdj'), 'two, and longer');
		await until(() => outside.length === 1, 'the watcher');
		expect(outside).toEqual(['two, and longer']);
		disk.close();
	});

	it('writes only the open file, only when the text differs, and never over an outside change', () => {
		const root = mkdtempSync(join(tmpdir(), 'aster-disk-'));
		writeFileSync(join(root, 'm.aster'), 'one');
		const disk = new DiskFile(root, 10_000);
		const outside: (string | null)[] = [];
		disk.onOutside = (p) => outside.push(p.text);
		expect(() => disk.write('m.aster', 'x')).toThrow(FileError);
		expect(disk.open('m.aster', 'Main')).toEqual({
			path: 'm.aster',
			name: 'm.aster',
			text: 'one',
			diagram: 'Main'
		});
		disk.write('m.aster', 'two');
		expect(readFileSync(join(root, 'm.aster'), 'utf8')).toBe('two');
		expect(disk.check()).toBe(false);
		writeFileSync(join(root, 'm.aster'), 'theirs');
		expect(() => disk.write('m.aster', 'three')).toThrow(/changed on disk/);
		expect(outside).toEqual(['theirs']);
		expect(readFileSync(join(root, 'm.aster'), 'utf8')).toBe('theirs');
		// Reloaded, the tab's next save goes through.
		disk.write('m.aster', 'four');
		expect(readFileSync(join(root, 'm.aster'), 'utf8')).toBe('four');
		disk.close();
		expect(disk.path).toBeNull();
	});
});
