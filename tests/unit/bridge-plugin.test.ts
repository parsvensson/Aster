import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle, modelRects, type Context } from '#lib/bridge/handle.ts';
import type { BridgeRequest, Hello } from '#lib/bridge/protocol.ts';
import { Stack, batch } from '#lib/commands/index.ts';
import { sampleProject } from '#lib/model/fixtures.ts';
import { Broker } from '../../scripts/mcp/broker.ts';
import { asterMcp } from '../../scripts/mcp/plugin.ts';

/**
 * The whole chain against a real Vite dev server: Claude Code's side (an MCP client over HTTP)
 * through the plugin and the HMR socket to a tab (a WebSocket speaking Vite's protocol, answering
 * with the real handler), and back.
 */

/** A tab: Vite's HMR socket from Node, answering requests from a sample project. */
class FakeTab {
	ws!: WebSocket;
	project = sampleProject();
	stack = new Stack(() => this.project);
	version = 0;
	received: string[] = [];
	constructor(
		readonly url: string,
		readonly name: string
	) {
		this.project.name = name;
	}
	get hello(): Hello {
		return {
			projectId: this.project.id,
			project: this.name,
			diagramId: 'd1',
			diagram: 'Main',
			route: 'sample',
			url: `http://localhost:5173/design/${this.name.toLowerCase()}`,
			version: this.version
		};
	}
	open(): Promise<void> {
		const ctx: Context = {
			project: this.project,
			get version() {
				return self.version;
			},
			activeDiagramId: 'd1',
			rects: (d) => modelRects(self.project, d),
			run: (plan) => {
				const label = self.stack.run(batch(self.project, plan));
				self.version++;
				self.send('aster:changed', { version: self.version, label, diagramId: 'd1' });
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
			})
		};
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url, 'vite-hmr');
			this.ws.onerror = () => reject(new Error('socket failed'));
			this.ws.onmessage = (ev) => {
				const msg = JSON.parse(String(ev.data)) as { type: string; event?: string; data?: unknown };
				if (msg.type === 'connected') resolve();
				if (msg.type !== 'custom') return;
				this.received.push(msg.event!);
				if (msg.event === 'aster:who') this.send('aster:hello', this.hello);
				if (msg.event === 'aster:req')
					void handle(msg.data as BridgeRequest, ctx).then((res) => this.send('aster:res', res));
			};
		});
	}
	send(event: string, data: unknown) {
		this.ws.send(JSON.stringify({ type: 'custom', event, data }));
	}
	close() {
		this.ws.close();
	}
}

const until = async (test: () => boolean, what: string, ms = 3000) => {
	const t0 = Date.now();
	while (!test()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

describe('the bridge on a real dev server', () => {
	let vite: ViteDevServer;
	let port: number;
	const broker = new Broker(3000);
	const tabs: FakeTab[] = [];

	beforeAll(async () => {
		const root = mkdtempSync(join(tmpdir(), 'aster-mcp-'));
		writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
		vite = await createServer({
			root,
			configFile: false,
			logLevel: 'silent',
			plugins: [asterMcp({ force: true, broker })],
			server: { host: '127.0.0.1', port: 5199, strictPort: false },
			optimizeDeps: { noDiscovery: true, include: [] }
		});
		await vite.listen();
		const address = vite.httpServer!.address();
		port = typeof address === 'object' && address ? address.port : 5199;
	}, 60_000);

	afterAll(async () => {
		for (const t of tabs) t.close();
		await vite.close();
	});

	const mcp = async () => {
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/__mcp`))
		);
		const call = async (name: string, args: Record<string, unknown> = {}) =>
			(await client.callTool({ name, arguments: args })) as CallToolResult;
		const textOf = (r: CallToolResult) =>
			r.content
				.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
				.map((c) => c.text)
				.join('');
		return { client, call, textOf };
	};

	it('serves MCP on /__mcp and says when no tab is there', async () => {
		const { client, call, textOf } = await mcp();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain('aster_set_text');
		const r = await call('aster_status');
		expect(r.isError).toBe(true);
		expect(textOf(r)).toMatch(/^no_tab/);
		await client.close();
	});

	it('asks a connecting socket who it is, and routes a tool call through the tab and back', async () => {
		const tab = new FakeTab(`ws://127.0.0.1:${port}/`, 'Library');
		tabs.push(tab);
		await tab.open();
		await until(() => broker.tabs.length === 1, 'the tab to say hello');
		expect(tab.received).toContain('aster:who');
		expect(broker.active?.hello.project).toBe('Library');

		const { client, call, textOf } = await mcp();
		const got = textOf(await call('aster_get_text', {}));
		expect(got).toContain('@startuml');
		const text = got.slice(got.indexOf('@startuml')).replace('@enduml', 'class Invoice\n@enduml');
		const written = textOf(await call('aster_set_text', { text, expectVersion: 0 }));
		expect(written).toMatch(/^Applied as "edit the text view via MCP" \(version 1\)/);
		expect(
			[...tab.project.elements.values()].some(
				(e) => e.kind === 'classifier' && e.name === 'Invoice'
			)
		).toBe(true);
		await until(() => broker.changesSince(0).length === 1, 'the change to be logged');
		const since = JSON.parse(textOf(await call('aster_changes_since', { version: 0 })));
		expect(since.changes[0]).toMatchObject({ version: 1, label: 'edit the text view via MCP' });
		expect(since.tab.project).toBe('Library');
		await client.close();
	});

	it('lists several tabs, lets the caller pick one, and forgets a tab that closes', async () => {
		const second = new FakeTab(`ws://127.0.0.1:${port}/`, 'Shop');
		tabs.push(second);
		await second.open();
		await until(() => broker.tabs.length === 2, 'the second tab');
		expect(broker.active?.hello.project).toBe('Shop');

		const { client, call, textOf } = await mcp();
		const status = JSON.parse(textOf(await call('aster_status')));
		expect(status.project.name).toBe('Shop');
		expect(
			status.tabs.map((t: { project: string; active: boolean }) => [t.project, t.active])
		).toEqual([
			['Shop', true],
			['Library', false]
		]);
		expect(textOf(await call('aster_use_tab', { tab: 'Library' }))).toMatch(
			/^Library at .* answers now/
		);
		expect(JSON.parse(textOf(await call('aster_status'))).project.name).toBe('Library');
		const none = await call('aster_use_tab', { tab: 'Nowhere' });
		expect(none.isError).toBe(true);

		second.close();
		await until(() => broker.tabs.length === 1, 'the closed tab to be forgotten');
		expect(broker.active?.hello.project).toBe('Library');
		await client.close();
	});

	it('refuses a request whose Host header is not local', async () => {
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				{
					host: '127.0.0.1',
					port,
					path: '/__mcp',
					method: 'POST',
					headers: { host: 'evil.example', 'content-type': 'application/json' }
				},
				(res) => resolve(res.statusCode ?? 0)
			);
			req.on('error', reject);
			req.end('{}');
		});
		// Vite's own host check answers first when it does not know the name; ours answers 403.
		expect([403, 421]).toContain(status);
	});
});
