import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { handle, type Context } from '#lib/bridge/handle.ts';
import type { BridgeRequest, Hello } from '#lib/bridge/protocol.ts';
import { Stack, batch } from '#lib/commands/index.ts';
import { sampleProject } from '#lib/model/fixtures.ts';
import { Broker, BrokerError, CHANGES_MAX } from '../../scripts/mcp/broker.ts';
import { CATALOGUE_IDS } from '../../scripts/mcp/catalogue.ts';
import { createMcpServer } from '../../scripts/mcp/server.ts';
import { isLocal } from '../../scripts/mcp/plugin.ts';
import { hydrate } from '#lib/commands/registry.ts';

const hello = (n = 1): Hello => ({
	projectId: 'p',
	project: `Project ${n}`,
	diagramId: 'd1',
	diagram: 'Main',
	route: '/design/sample',
	url: 'http://localhost:5173/design/sample',
	version: 0
});

/** A tab that answers through the real handler, from a sample project and a stack. */
function liveTab(broker: Broker, key: object = {}, extra: Pick<Context, 'toPng' | 'fontCss'> = {}) {
	const project = sampleProject();
	const stack = new Stack(() => project);
	let version = 0;
	const ctx: Context = {
		get project() {
			return project;
		},
		get version() {
			return version;
		},
		activeDiagramId: 'd1',
		rects: () => new Map(),
		run: (plan) => {
			const label = stack.run(batch(project, plan));
			version++;
			broker.changed({ version, label, diagramId: 'd1' });
			return label;
		},
		ui: () => ({
			file: null,
			state: 'new',
			editor: true,
			route: '/design/sample',
			url: 'http://localhost:5173/design/sample',
			selection: [],
			editing: false,
			undoLabel: stack.undoLabel,
			redoLabel: stack.redoLabel
		}),
		...extra
	};
	broker.hello(
		key,
		(event, payload) => {
			if (event === 'aster:req')
				void handle(payload as BridgeRequest, ctx).then((res) => broker.response(res));
		},
		hello()
	);
	return { project, stack };
}

describe('broker', () => {
	it('has no one to ask until a tab says hello', async () => {
		const b = new Broker();
		await expect(b.request('status', {})).rejects.toMatchObject({ code: 'no_tab' });
		expect(b.active).toBeNull();
	});

	it('sends the request to the newest tab and resolves on its response', async () => {
		const b = new Broker();
		const sent: unknown[] = [];
		b.hello({}, (event, payload) => sent.push([event, payload]), hello(1));
		const k2 = {};
		b.hello(k2, (event, payload) => sent.push([event, payload]), hello(2));
		expect(b.active?.hello.project).toBe('Project 2');
		expect(b.tabs).toHaveLength(2);

		const p = b.request('get_text', { dialect: 'puml' });
		const [event, req] = sent.at(-1) as [string, BridgeRequest];
		expect(event).toBe('aster:req');
		expect(req.method).toBe('get_text');
		b.response({ id: req.id, ok: true, version: 3, result: { text: 'x' } as never });
		await expect(p).resolves.toEqual({ text: 'x' });

		// A refusal becomes a rejection with the tab's code; a stray response is ignored.
		const q = b.request('status', {});
		const [, req2] = sent.at(-1) as [string, BridgeRequest];
		b.response({ id: 'nobody', ok: false, code: 'failed', error: 'late' });
		b.response({ id: req2.id, ok: false, code: 'stale', error: 'moved on' });
		await expect(q).rejects.toMatchObject({ code: 'stale', message: 'moved on' });

		// When the active tab closes, the other one answers.
		b.gone(k2);
		expect(b.active?.hello.project).toBe('Project 1');
	});

	it('gives up on a silent tab', async () => {
		const b = new Broker(20);
		b.hello({}, () => {}, hello());
		await expect(b.request('status', {})).rejects.toBeInstanceOf(BrokerError);
		await expect(new Broker(20).request('status', {})).rejects.toMatchObject({ code: 'no_tab' });
	});

	it('keeps the last changes and answers "since"', () => {
		const b = new Broker();
		for (let v = 1; v <= CHANGES_MAX + 5; v++)
			b.changed({ version: v, label: `step ${v}`, diagramId: 'd1' });
		expect(b.changes).toHaveLength(CHANGES_MAX);
		expect(b.changesSince(CHANGES_MAX + 3).map((c) => c.version)).toEqual([
			CHANGES_MAX + 4,
			CHANGES_MAX + 5
		]);
	});
});

describe('the MCP endpoint answers only the local computer', () => {
	const req = (remoteAddress: string, host: string) =>
		({ socket: { remoteAddress }, headers: { host } }) as never;
	it('accepts loopback with a local host header', () => {
		expect(isLocal(req('127.0.0.1', 'localhost:5173'))).toBe(true);
		expect(isLocal(req('::1', '[::1]:5173'))).toBe(true);
		expect(isLocal(req('::ffff:127.0.0.1', 'app.localhost:5173'))).toBe(true);
	});
	it('refuses another machine, or a rebound name', () => {
		expect(isLocal(req('192.168.1.7', 'localhost:5173'))).toBe(false);
		expect(isLocal(req('127.0.0.1', 'evil.example:5173'))).toBe(false);
	});
});

describe('MCP server', () => {
	async function connect() {
		const broker = new Broker();
		const server = createMcpServer(broker);
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientT);
		const call = async (name: string, args: Record<string, unknown> = {}) =>
			(await client.callTool({ name, arguments: args })) as CallToolResult;
		const textOf = (r: CallToolResult) =>
			r.content
				.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
				.map((c) => c.text)
				.join('');
		return { broker, client, call, textOf };
	}

	it('lists the tools', async () => {
		const { client } = await connect();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			'aster_add_classifier',
			'aster_add_diagram',
			'aster_add_note',
			'aster_add_to_diagram',
			'aster_arrange',
			'aster_changes_since',
			'aster_commands',
			'aster_connect',
			'aster_delete',
			'aster_display',
			'aster_find',
			'aster_get_element',
			'aster_get_project',
			'aster_get_selection',
			'aster_get_text',
			'aster_layout',
			'aster_move_to_package',
			'aster_open_diagram',
			'aster_redo',
			'aster_render',
			'aster_run',
			'aster_select',
			'aster_set_members',
			'aster_set_text',
			'aster_status',
			'aster_undo',
			'aster_update',
			'aster_validate'
		]);
	});

	it('serves the command catalogue, whose ids are all registered commands', async () => {
		const { client, call, textOf } = await connect();
		const md = textOf(await call('aster_commands'));
		expect(md).toContain('| connect |');
		const { contents } = await client.readResource({ uri: 'aster://commands' });
		expect(contents[0]).toMatchObject({ uri: 'aster://commands', mimeType: 'text/markdown' });
		// Every id the catalogue names is a registered command: hydrating it fails on its args, never on its id.
		const project = sampleProject();
		expect(CATALOGUE_IDS.length).toBeGreaterThan(40);
		for (const id of CATALOGUE_IDS) {
			let message = '';
			try {
				hydrate(project, { id, args: {} });
			} catch (e) {
				message = e instanceof Error ? e.message : String(e);
			}
			expect(message, id).not.toMatch(/Unknown command/);
		}
	});

	it('reports an error, not a crash, when no tab is connected', async () => {
		const { call, textOf } = await connect();
		const r = await call('aster_status');
		expect(r.isError).toBe(true);
		expect(textOf(r)).toMatch(/^no_tab: No Aster tab is connected/);
	});

	it('reads and writes the open diagram through a tab', async () => {
		const { broker, call, textOf } = await connect();
		const { project, stack } = liveTab(broker);

		const status = JSON.parse(textOf(await call('aster_status')));
		expect(status.project.name).toBe(project.name);
		expect(status.tabs).toBe(1);

		const got = textOf(await call('aster_get_text', {}));
		expect(got).toMatch(/^\/\/ .* \(d1\), version 0\n@startuml/);
		const text = got.slice(got.indexOf('@startuml'));

		const written = await call('aster_set_text', {
			text: text.replace('@enduml', 'class Invoice\n@enduml'),
			expectVersion: 0
		});
		expect(written.isError).toBeUndefined();
		expect(textOf(written)).toMatch(/^Applied as "edit the text view via MCP" \(version 1\)/);
		expect(
			[...project.elements.values()].some((e) => e.kind === 'classifier' && e.name === 'Invoice')
		).toBe(true);
		expect(stack.undoLabel).toBe('edit the text view via MCP');
		expect(broker.changesSince(0)).toHaveLength(1);

		// Stale version: refused with the tab's words.
		const stale = await call('aster_set_text', { text, expectVersion: 0 });
		expect(stale.isError).toBe(true);
		expect(textOf(stale)).toMatch(/^stale: The model is at version 1/);

		// A syntax error: refused, nothing ran.
		const bad = await call('aster_set_text', { text: '@startuml\nclass A {\n@enduml' });
		expect(bad.isError).toBe(true);
		expect(textOf(bad)).toMatch(/^syntax: Line 2: missing }/);
		expect(stack.depth).toBe(1);

		// The change log answers from the server, with the tab that answers.
		const since = JSON.parse(textOf(await call('aster_changes_since', { version: 0 })));
		expect(since.changes).toEqual([
			{ version: 1, label: 'edit the text view via MCP', diagramId: 'd1' }
		]);
		expect(since.tab.project).toBe('Project 1');
		expect(since.tabs).toBe(1);
	});

	it('returns the PNG as an image block and the SVG as text', async () => {
		const { broker, call } = await connect();
		liveTab(broker, {}, { toPng: async () => 'QUJD', fontCss: async () => '' });
		const png = await call('aster_render', {});
		expect(png.content.map((c) => c.type)).toEqual(['text', 'image']);
		expect(png.content[1]).toMatchObject({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
		const svg = await call('aster_render', { format: 'svg' });
		expect(svg.content[0]).toMatchObject({ type: 'text' });
		expect((svg.content[0] as { text: string }).text).toContain('<svg');
	});
});
