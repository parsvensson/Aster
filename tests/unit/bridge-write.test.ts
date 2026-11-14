import { describe, expect, it } from 'vitest';
import {
	handle,
	membersFromLines,
	modelRects,
	type Context,
	type UiState
} from '#lib/bridge/handle.ts';
import type { BridgeRequest, Method, Params, Results } from '#lib/bridge/protocol.ts';
import { Stack, batch } from '#lib/commands/index.ts';
import { sampleProject } from '#lib/model/fixtures.ts';
import {
	createClassifier,
	createRelationship,
	getClassifier,
	getNodeLayout
} from '#lib/model/project.ts';
import type { Classifier, Project, Relationship } from '#lib/model/types.ts';
import { structural } from './helpers.ts';

/** A tab stood in by a project and a stack, with fakes for what only the tab can do. */
function tab(project: Project = sampleProject(), hooks: Partial<Context> = {}) {
	let version = 0;
	const stack = new Stack(() => project);
	const calls: unknown[] = [];
	const ui: UiState = {
		file: null,
		state: 'new',
		editor: true,
		route: '/design/sample',
		url: 'http://localhost:5173/design/sample',
		selection: [],
		editing: false,
		undoLabel: null,
		redoLabel: null
	};
	const ctx: Context = {
		get project() {
			return project;
		},
		get version() {
			return version;
		},
		activeDiagramId: 'd1',
		rects: (d) => modelRects(project, d),
		run: (plan) => {
			const label = stack.run(batch(project, plan));
			version++;
			return label;
		},
		ui: () => ({ ...ui, undoLabel: stack.undoLabel, redoLabel: stack.redoLabel }),
		select: (ids, centre) => void calls.push(['select', ids, centre]),
		openDiagram: (id) => void calls.push(['open', id]),
		undo: () => {
			const l = stack.undo();
			version++;
			return l;
		},
		redo: () => {
			const l = stack.redo();
			version++;
			return l;
		},
		...hooks
	};
	let n = 0;
	const ask = <M extends Method>(method: M, params: Params[M]) =>
		handle({ id: `t${++n}`, method, params } as BridgeRequest, ctx);
	const ok = async <M extends Method>(method: M, params: Params[M]): Promise<Results[M]> => {
		const res = await ask(method, params);
		if (!res.ok) throw new Error(`${res.code}: ${res.error}`);
		return res.result as Results[M];
	};
	const fail = async (method: Method, params: unknown) => {
		const res = await ask(method, params as never);
		if (res.ok) throw new Error(`expected ${method} to fail`);
		return res;
	};
	return { project, stack, ctx, ask, ok, fail, calls, undo: () => (stack.undo(), version++) };
}

const hiddenGhost = () => {
	const p = sampleProject();
	p.elements.set('Ghost', createClassifier({ id: 'Ghost', name: 'Ghost' }));
	return p;
};

describe('bridge: adding classifiers', () => {
	it('creates a class with parsed members, right of a neighbour, as one undo step', async () => {
		const t = tab();
		const before = structural(t.project);
		const r = await t.ok('add_classifier', {
			name: 'Order',
			stereotype: 'entity',
			abstract: true,
			attributes: ['- total: Money = 0', '# {static} count: int'],
			operations: ['+ pay(amount: Money): Receipt'],
			documentation: 'An order.',
			near: 'Account'
		});
		expect(r.label).toBe('create class Order via MCP');
		const c = getClassifier(t.project, r.id);
		expect(c).toMatchObject({ name: 'Order', stereotype: 'entity', isAbstract: true });
		expect(
			c.attributes.map((a) => [a.name, a.type, a.visibility, a.isStatic, a.defaultValue])
		).toEqual([
			['total', 'Money', 'private', false, '0'],
			['count', 'int', 'protected', true, undefined]
		]);
		expect(c.operations[0]).toMatchObject({ name: 'pay', returnType: 'Receipt' });
		expect(c.operations[0].parameters).toEqual([
			{ name: 'amount', type: 'Money', direction: 'in' }
		]);
		const d = t.project.diagrams[0];
		const account = getNodeLayout(d, 'Account');
		const order = getNodeLayout(d, r.id);
		// Right of Account; free space may be further down when a neighbour sits there already.
		expect(order.x).toBeGreaterThanOrEqual(account.x + account.w);
		expect(order.y).toBeGreaterThanOrEqual(account.y);
		t.undo();
		expect(structural(t.project)).toEqual(before);
	});

	it('takes an explicit position, an enum with literals, and refuses a nameless one', async () => {
		const t = tab();
		const r = await t.ok('add_classifier', {
			name: 'Status',
			kind: 'enum',
			literals: ['OPEN', 'CLOSED'],
			at: { x: 500, y: 20 }
		});
		const c = getClassifier(t.project, r.id);
		expect(c.classifierKind).toBe('enum');
		expect(c.literals.map((l) => l.name)).toEqual(['OPEN', 'CLOSED']);
		expect(getNodeLayout(t.project.diagrams[0], r.id)).toMatchObject({ x: 500, y: 20 });
		expect((await t.fail('add_classifier', { name: '  ' })).code).toBe('bad_args');
		expect((await t.fail('add_classifier', { name: 'X', near: 'Ghost' })).code).toBe('no_element');
	});
});

describe('bridge: members', () => {
	it('reuses a member that still reads the same, edits one in place, adds the rest', () => {
		const existing = sampleProject().elements.get('Account') as Classifier;
		const [a0, , a2] = existing.attributes;
		// Line 0 sits where a0 sat: an edit of a0. Line 1 reads exactly as a2: a2 itself. Line 2
		// finds its position (a2) claimed and nothing matching: a new member.
		const out = membersFromLines(
			existing.attributes,
			'attribute',
			['- renamed: int', '# attribute2: String', '+ brandNew: Date'],
			() => 'new'
		);
		expect(out.map((m) => m.id)).toEqual([a0.id, a2.id, 'new']);
		expect((out[0] as { name: string }).name).toBe('renamed');
		expect(out[0].documentation).toBe(a0.documentation);
	});

	it('sets one compartment, keeps the others, and reports no change for the same lines', async () => {
		const t = tab();
		const account = getClassifier(t.project, 'Account');
		const ops = account.operations.length;
		const r = await t.ok('set_members', {
			id: 'Account',
			attributes: ['- balance: Money', '- owner: Customer']
		});
		expect(r.label).toBe('edit Account via MCP');
		const after = getClassifier(t.project, 'Account');
		expect(after.attributes.map((a) => a.name)).toEqual(['balance', 'owner']);
		expect(after.operations).toHaveLength(ops);
		const same = await t.ok('set_members', {
			id: 'Account',
			attributes: ['- balance: Money', '- owner: Customer']
		});
		expect(same.label).toBeNull();
		expect((await t.fail('set_members', { id: 'nope', attributes: [] })).code).toBe('no_element');
	});
});

describe('bridge: connecting and updating', () => {
	it('connects with ends and a name, refuses ends on a generalization and an undrawn end', async () => {
		const t = tab(hiddenGhost());
		const r = await t.ok('connect', {
			source: 'Account',
			target: 'Customer',
			kind: 'composition',
			name: 'holder',
			sourceEnd: { multiplicity: '1..*', role: 'accounts' },
			targetEnd: { multiplicity: '1', navigable: 'navigable' }
		});
		expect(r.label).toBe('connect Account to Customer, composition via MCP');
		const rel = t.project.elements.get(r.id) as Relationship;
		expect(rel).toMatchObject({ relationshipKind: 'composition', name: 'holder' });
		expect(rel.sourceEnd).toMatchObject({ multiplicity: '1..*', role: 'accounts' });
		expect(rel.targetEnd).toMatchObject({ multiplicity: '1', navigable: 'navigable' });
		expect(t.project.diagrams[0].layout.get(r.id)?.kind).toBe('edge');
		expect(t.stack.depth).toBe(1);
		expect(
			(
				await t.fail('connect', {
					source: 'Account',
					target: 'Customer',
					kind: 'generalization',
					sourceEnd: { role: 'x' }
				})
			).code
		).toBe('bad_args');
		expect(
			(await t.fail('connect', { source: 'Account', target: 'Ghost', kind: 'dependency' })).code
		).toBe('not_on_diagram');
	});

	it('updates a classifier, a relationship, a note; refuses fields that do not fit', async () => {
		const t = tab();
		t.project.elements.set(
			'r1',
			createRelationship({
				id: 'r1',
				relationshipKind: 'association',
				sourceId: 'Account',
				targetId: 'Customer'
			})
		);
		const c = await t.ok('update', {
			id: 'Account',
			name: 'Konto',
			abstract: false,
			stereotype: null,
			documentation: 'Ett konto'
		});
		// Several changes at once are labelled with the name the element had.
		expect(c.label).toBe('edit Account via MCP');
		const konto = getClassifier(t.project, 'Account');
		expect(konto).toMatchObject({ name: 'Konto', isAbstract: false, documentation: 'Ett konto' });
		expect(konto.stereotype).toBeUndefined();
		const one = await t.ok('update', { id: 'Customer', abstract: true });
		expect(one.label).toBe('change Customer via MCP');
		const r = await t.ok('update', {
			id: 'r1',
			relationshipKind: 'aggregation',
			flip: true,
			name: 'owns'
		});
		expect(r.label).toBe('edit association via MCP');
		const rel = t.project.elements.get('r1') as Relationship;
		expect(rel).toMatchObject({
			relationshipKind: 'aggregation',
			sourceId: 'Customer',
			targetId: 'Account',
			name: 'owns'
		});
		const nothing = await t.ok('update', { id: 'Customer', abstract: true });
		expect(nothing.label).toBeNull();
		const wrong = await t.fail('update', { id: 'Customer', flip: true });
		expect(wrong.code).toBe('bad_args');
		expect(wrong.error).toMatch(/has no flip/);
	});
});

describe('bridge: notes, packages, positions, flags, diagrams', () => {
	it('adds a linked note', async () => {
		const t = tab();
		const r = await t.ok('add_note', { text: 'Remember', linkTo: ['Account'] });
		expect(r.label).toBe('add a note via MCP');
		expect(t.project.elements.get(r.id)).toMatchObject({
			kind: 'note',
			text: 'Remember',
			linkedIds: ['Account']
		});
		expect(t.project.diagrams[0].layout.get(r.id)?.kind).toBe('node');
	});

	it('creates a package on demand, moves into it and back out', async () => {
		const t = tab();
		const made = await t.ok('move_to_package', {
			ids: ['Account', 'Customer'],
			package: 'Domain',
			create: true
		});
		expect(made.label).toBe('add package Domain via MCP');
		expect(made.packageId).toBeTruthy();
		expect(getClassifier(t.project, 'Account').packageId).toBe(made.packageId);
		expect(t.project.elements.get(made.packageId!)).toMatchObject({
			kind: 'package',
			name: 'Domain',
			memberIds: ['Account', 'Customer']
		});
		const again = await t.ok('move_to_package', { ids: ['Account'], package: 'Domain' });
		expect(again.label).toBeNull();
		const out = await t.ok('move_to_package', { ids: ['Account'], package: null });
		expect(out.label).toMatch(/^move Account to/);
		expect(getClassifier(t.project, 'Account').packageId).toBeUndefined();
		expect((await t.fail('move_to_package', { ids: ['Account'], package: 'Nope' })).code).toBe(
			'no_element'
		);
		expect((await t.fail('move_to_package', { ids: ['Account'], package: 'Customer' })).code).toBe(
			'bad_args'
		);
	});

	it('arranges nodes and refuses one that is not drawn', async () => {
		const t = tab(hiddenGhost());
		const r = await t.ok('arrange', {
			positions: { Account: { x: 10, y: 20 }, Customer: { x: 300, y: 20 } }
		});
		expect(r.label).toMatch(/via MCP$/);
		expect(getNodeLayout(t.project.diagrams[0], 'Account')).toMatchObject({ x: 10, y: 20 });
		expect((await t.ok('arrange', { positions: { Account: { x: 10, y: 20 } } })).label).toBeNull();
		expect((await t.fail('arrange', { positions: { Ghost: { x: 0, y: 0 } } })).code).toBe(
			'not_on_diagram'
		);
	});

	it('sets display flags on nodes or on the diagram, and refuses an unknown flag', async () => {
		const t = tab();
		const nodes = await t.ok('display', {
			ids: ['Account'],
			flags: { suppressAttributes: true, stereotypeDisplay: 'none' }
		});
		expect(nodes.label).toMatch(/^change display: .* via MCP$/);
		expect(getNodeLayout(t.project.diagrams[0], 'Account').flags).toEqual({
			suppressAttributes: true,
			stereotypeDisplay: 'none'
		});
		const defaults = await t.ok('display', { flags: { showVisibility: false } });
		expect(defaults.label).toMatch(/via MCP$/);
		expect(t.project.diagrams[0].defaults.showVisibility).toBe(false);
		const wrong = await t.fail('display', { flags: { showEverything: true } });
		expect(wrong.code).toBe('bad_args');
	});

	it('adds and opens a diagram, selects, undoes and redoes through the tab', async () => {
		const t = tab();
		const d = await t.ok('add_diagram', { name: 'Payments', open: true });
		expect(d.label).toBe('add diagram Payments via MCP');
		expect(t.project.diagrams.map((x) => x.name)).toContain('Payments');
		expect(t.calls).toContainEqual(['open', d.diagramId]);
		await t.ok('open_diagram', { diagram: 'Payments' });
		expect(t.calls.at(-1)).toEqual(['open', d.diagramId]);
		const s = await t.ok('select', { ids: ['Account'], centre: true });
		expect(s.selection).toEqual(['Account']);
		expect(t.calls.at(-1)).toEqual(['select', ['Account'], true]);
		const u = await t.ok('undo', {});
		expect(u.label).toBe('add diagram Payments via MCP');
		expect(t.project.diagrams.map((x) => x.name)).not.toContain('Payments');
		const rd = await t.ok('redo', {});
		expect(rd.label).toBe('add diagram Payments via MCP');
	});

	it('hands auto-layout to the tab with the resolved ids, and says so when there is none', async () => {
		const seen: unknown[] = [];
		const t = tab(sampleProject(), {
			layout: async (...args) => {
				seen.push(args);
				return 'lay out Main';
			}
		});
		const r = await t.ok('layout', {
			algorithm: 'orthogonal',
			direction: 'RIGHT',
			only: ['Account', 'Customer']
		});
		expect(r.label).toBe('lay out Main');
		expect(seen).toEqual([['d1', 'orthogonal', 'RIGHT', ['Account', 'Customer']]]);
		await t.ok('layout', {});
		expect(seen[1]).toEqual(['d1', 'layered', 'DOWN', null]);
		expect((await t.fail('layout', { only: ['Account'] })).code).toBe('bad_args');
		const bare = tab(sampleProject(), { layout: undefined });
		expect((await bare.fail('layout', {})).code).toBe('failed');
	});
});

describe('bridge: raw commands', () => {
	it('runs registered commands as one labelled step; refuses bad shapes and unknown ids', async () => {
		const t = tab();
		const r = await t.ok('run', {
			label: 'rename and document',
			commands: [
				{ id: 'renameClassifier', args: { id: 'Account', name: 'Konto' } },
				{ id: 'setDocumentation', args: { id: 'Account', documentation: 'doc' } }
			]
		});
		expect(r.label).toBe('rename and document via MCP');
		expect(getClassifier(t.project, 'Account')).toMatchObject({
			name: 'Konto',
			documentation: 'doc'
		});
		expect(t.stack.depth).toBe(1);
		expect((await t.fail('run', { label: 'x', commands: [] })).code).toBe('bad_args');
		expect(
			(await t.fail('run', { label: '', commands: [{ id: 'renameClassifier', args: {} }] })).code
		).toBe('bad_args');
		const unknown = await t.fail('run', { label: 'x', commands: [{ id: 'explode', args: {} }] });
		expect(unknown.code).toBe('failed');
		expect(unknown.error).toMatch(/Unknown command explode/);
		expect(t.stack.depth).toBe(1);
	});
});
