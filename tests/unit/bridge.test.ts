import { describe, expect, it } from 'vitest';
import {
	diagramOf,
	elementOf,
	handle,
	modelRects,
	planText,
	type Context,
	type UiState
} from '#lib/bridge/handle.ts';
import type {
	BridgeRequest,
	DeleteResult,
	ElementDetail,
	ElementInfo,
	Method,
	Params,
	ProjectResult,
	RenderResult,
	SelectionResult,
	SetTextResult,
	ShowResult,
	Status,
	TextResult,
	ValidateResult
} from '#lib/bridge/protocol.ts';
import { Stack, batch } from '#lib/commands/index.ts';
import { sampleProject } from '#lib/model/fixtures.ts';
import { createClassifier, createDiagram, createRelationship } from '#lib/model/project.ts';
import type { Project } from '#lib/model/types.ts';
import { structural } from './helpers.ts';

/** A tab stood in by a project and a stack: what client.svelte.ts supplies from the stores. */
function tab(
	project: Project = sampleProject(),
	ui: Partial<UiState> = {},
	extra: Pick<Context, 'toPng' | 'fontCss'> = {}
) {
	let version = 0;
	const stack = new Stack(() => project);
	const ctx: Context = {
		get project() {
			return project;
		},
		get version() {
			return version;
		},
		activeDiagramId: project.diagrams[0].id,
		rects: (d) => modelRects(project, d),
		...extra,
		run: (plan) => {
			const label = stack.run(batch(project, plan));
			version++;
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
			redoLabel: stack.redoLabel,
			...ui
		})
	};
	let n = 0;
	const ask = <M extends Method>(method: M, params: Params[M]) =>
		handle({ id: `t${++n}`, method, params } as BridgeRequest, ctx);
	return { project, stack, ctx, ask, undo: () => (stack.undo(), version++) };
}

const ok = <T>(res: Awaited<ReturnType<typeof handle>>): T => {
	if (!res.ok) throw new Error(`${res.code}: ${res.error}`);
	return res.result as T;
};

describe('bridge: status', async () => {
	it('reports the project, its diagrams, counts, selection and undo labels', async () => {
		const t = tab(sampleProject(), { selection: ['Account', 'nope'] });
		const s = ok<Status>(await t.ask('status', {}));
		expect(s.project.name).toBe(t.project.name);
		expect(s.diagrams.map((d) => d.id)).toEqual(t.project.diagrams.map((d) => d.id));
		expect(s.activeDiagramId).toBe(t.project.diagrams[0].id);
		expect(s.counts.classifiers).toBeGreaterThanOrEqual(2);
		// Only ids the model knows are described; a stale one is left out.
		expect(s.selection).toEqual([{ id: 'Account', kind: 'classifier', name: 'Account' }]);
		expect(s.undoLabel).toBeNull();
		expect(s.editor).toBe(true);
	});

	it('answers on the welcome page too, saying there is no editor', async () => {
		const t = tab(sampleProject(), { editor: false, route: null });
		expect(ok<Status>(await t.ask('status', {})).editor).toBe(false);
		const res = await t.ask('get_text', {});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe('no_editor');
	});
});

describe('bridge: diagrams by id or name', async () => {
	it('resolves an id, a unique name, and the active one; names the candidates otherwise', async () => {
		const p = sampleProject();
		const [d] = p.diagrams;
		expect(diagramOf(p, d.id, d.id)).toBe(d);
		expect(diagramOf(p, d.name, 'x')).toBe(d);
		expect(diagramOf(p, undefined, d.id)).toBe(d);
		expect(() => diagramOf(p, 'Nope', d.id)).toThrow(/No diagram Nope/);
		p.diagrams.push(createDiagram({ id: 'twin', name: d.name }));
		expect(() => diagramOf(p, d.name, d.id)).toThrow(/2 diagrams are named/);
		expect(() => diagramOf(p, undefined, 'gone')).toThrow(/no open diagram/);
	});
});

describe('bridge: text', async () => {
	it('prints PlantUML by default and Mermaid on request', async () => {
		const t = tab();
		const puml = ok<TextResult>(await t.ask('get_text', {}));
		expect(puml.dialect).toBe('puml');
		expect(puml.text).toMatch(/^@startuml/);
		expect(puml.text).toContain('Account');
		const mmd = ok<TextResult>(await t.ask('get_text', { dialect: 'mermaid' }));
		expect(mmd.text).toContain('classDiagram');
	});

	it('applies a text as one labelled undo step, keeps ids, and undoes back to the start', async () => {
		const t = tab();
		const before = structural(t.project);
		const ids = new Set(t.project.elements.keys());
		const { text, version } = ok<TextResult>(await t.ask('get_text', {}));
		const edited = text.replace(
			'@enduml',
			'class Book {\n  +title: String\n}\nAccount --> Book\n@enduml'
		);
		const r = ok<SetTextResult>(await t.ask('set_text', { text: edited, expectVersion: version }));
		expect(r.changed).toBe(true);
		expect(r.label).toMatch(/via MCP$/);
		expect(r.version).toBe(version + 1);
		expect(r.text).toContain('class Book');
		expect(t.stack.undoLabel).toBe(r.label);
		// Every element that was there still is, under its id; Book and the arrow are new.
		for (const id of ids) expect(t.project.elements.has(id)).toBe(true);
		expect(t.project.elements.size).toBe(ids.size + 2);
		t.undo();
		expect(structural(t.project)).toEqual(before);
	});

	it('changes nothing when the text already matches', async () => {
		const t = tab();
		const { text } = ok<TextResult>(await t.ask('get_text', {}));
		const r = ok<SetTextResult>(await t.ask('set_text', { text }));
		expect(r.changed).toBe(false);
		expect(r.label).toBeNull();
		expect(t.stack.canUndo).toBe(false);
	});

	it('refuses a syntax error with the Text view wording, and runs nothing', async () => {
		const t = tab();
		const res = await t.ask('set_text', { text: '@startuml\nclass Broken {\n  +x: int\n@enduml' });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.code).toBe('syntax');
			expect(res.error).toMatch(/Line 2: missing } for class Broken/);
		}
		expect(t.stack.canUndo).toBe(false);
	});

	it('refuses a write based on an old version', async () => {
		const t = tab();
		const res = await t.ask('set_text', { text: '@startuml\nclass X\n@enduml', expectVersion: 7 });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe('stale');
		expect(t.stack.canUndo).toBe(false);
	});

	it('refuses to rewrite an object diagram from the class dialect', async () => {
		const p = sampleProject();
		p.diagrams.push(createDiagram({ id: 'obj', name: 'Objects', diagramKind: 'object' }));
		const t = tab(p);
		const res = await t.ask('set_text', { text: '@startuml\nclass X\n@enduml', diagram: 'obj' });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe('object_diagram');
		expect(() => planText(p, p.diagrams[1], '@startuml\n@enduml', [])).toThrow(/object diagram/);
	});

	it('never throws: an unknown method is an error response', async () => {
		const t = tab();
		const res = await handle({ id: 'x', method: 'explode' as Method, params: {} }, t.ctx);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe('unknown_method');
	});
});

/** The sample plus a class and a relationship that no diagram shows. */
function withHidden() {
	const p = sampleProject();
	p.elements.set('Ghost', createClassifier({ id: 'Ghost', name: 'Ghost', stereotype: 'Concept' }));
	p.elements.set(
		'Ghost-Account',
		createRelationship({
			id: 'Ghost-Account',
			relationshipKind: 'association',
			sourceId: 'Ghost',
			targetId: 'Account'
		})
	);
	p.unknown.push({
		json: { _type: 'UMLSequenceDiagram', lifeline: { $ref: 'Ghost' } },
		parentId: null,
		path: 'ownedElements',
		index: 0
	});
	// An element's own #source record (its .mdj JSON, kept for the round trip) is not a reference.
	p.unknown.push({
		json: { _type: 'UMLAssociation', _id: 'Ghost-Account' },
		parentId: 'Ghost-Account',
		path: '#source',
		index: 0
	});
	return p;
}

describe('bridge: the whole model', async () => {
	it('lists the elements no diagram shows, flagging what unseen content still refers to', async () => {
		const t = tab(withHidden());
		const r = ok<ProjectResult>(await t.ask('get_project', {}));
		const project = r.project as {
			elements: Record<string, unknown>;
			diagrams: { layout?: unknown }[];
		};
		expect(Object.keys(project.elements)).toContain('Ghost');
		expect(project.diagrams[0].layout).toBeUndefined();
		expect(r.hidden.map((h) => [h.id, h.inUnknown])).toEqual([
			['Ghost', true],
			['Ghost-Account', false]
		]);
		expect(r.hidden[0]).toMatchObject({
			kind: 'classifier',
			name: 'Ghost',
			stereotype: 'Concept',
			onDiagrams: []
		});
		const full = ok<ProjectResult>(await t.ask('get_project', { layout: true }));
		expect((full.project as { diagrams: { layout: unknown }[] }).diagrams[0].layout).toBeDefined();
	});

	it('resolves elements by id or unique name', async () => {
		const p = withHidden();
		expect(elementOf(p, 'Ghost').id).toBe('Ghost');
		expect(elementOf(p, 'Account').id).toBe('Account');
		expect(() => elementOf(p, 'Nobody')).toThrow(/No element Nobody/);
		// An id always wins; two elements sharing a name that is no id must be told apart.
		p.elements.set('Twin1', createClassifier({ id: 'Twin1', name: 'Dup' }));
		p.elements.set('Twin2', createClassifier({ id: 'Twin2', name: 'Dup' }));
		expect(() => elementOf(p, 'Dup')).toThrow(/2 elements are named Dup/);
	});
});

describe('bridge: views and deletion', async () => {
	it('shows a hidden class where asked, draws its relationship, and undoes both', async () => {
		const t = tab(withHidden());
		const before = structural(t.project);
		const r = ok<ShowResult>(
			await t.ask('add_to_diagram', { ids: ['Ghost'], at: { Ghost: { x: 400, y: 60 } } })
		);
		expect(r.added).toEqual(['Ghost', 'Ghost-Account']);
		expect(r.label).toMatch(/^add 2 elements to diagram via MCP$/);
		const d = t.project.diagrams[0];
		expect(d.layout.get('Ghost')).toMatchObject({ kind: 'node', x: 400, y: 60 });
		expect(d.layout.get('Ghost-Account')?.kind).toBe('edge');
		// Asking again adds nothing and runs nothing.
		const again = ok<ShowResult>(await t.ask('add_to_diagram', { ids: ['Ghost'] }));
		expect(again.label).toBeNull();
		expect(t.stack.depth).toBe(1);
		t.undo();
		expect(structural(t.project)).toEqual(before);
	});

	it('can leave relationships undrawn, and finds free space without `at`', async () => {
		const t = tab(withHidden());
		const r = ok<ShowResult>(
			await t.ask('add_to_diagram', { ids: ['Ghost'], relationships: false })
		);
		expect(r.added).toEqual(['Ghost']);
		const l = t.project.diagrams[0].layout.get('Ghost');
		expect(l?.kind).toBe('node');
	});

	it('deletes from the model with the lines that touch it, as one undoable step', async () => {
		const t = tab(withHidden());
		const before = structural(t.project);
		const r = ok<DeleteResult>(
			await t.ask('delete', { ids: ['Ghost'], from: 'model', expectVersion: 0 })
		);
		expect(r.deleted).toEqual(['Ghost']);
		expect(r.label).toMatch(/via MCP$/);
		expect(t.project.elements.has('Ghost')).toBe(false);
		expect(t.project.elements.has('Ghost-Account')).toBe(false);
		t.undo();
		expect(structural(t.project)).toEqual(before);
	});

	it('removes only the view when asked to delete from a diagram', async () => {
		const t = tab();
		const r = ok<DeleteResult>(await t.ask('delete', { ids: ['Account'], from: 'diagram' }));
		expect(r.deleted).toEqual(['Account']);
		expect(t.project.elements.has('Account')).toBe(true);
		expect(t.project.diagrams[0].elementIds).not.toContain('Account');
		const none = ok<DeleteResult>(await t.ask('delete', { ids: ['Account'], from: 'diagram' }));
		expect(none.label).toBeNull();
	});

	it('refuses a stale delete and an unknown element', async () => {
		const t = tab();
		const stale = await t.ask('delete', { ids: ['Account'], from: 'model', expectVersion: 9 });
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.code).toBe('stale');
		const nobody = await t.ask('delete', { ids: ['Nobody'], from: 'model' });
		expect(nobody.ok).toBe(false);
		if (!nobody.ok) expect(nobody.code).toBe('no_element');
		expect(t.stack.canUndo).toBe(false);
	});
});

describe('bridge: reading one element, finding, selection, validation', () => {
	it('details an element with its layouts and the lines that touch it', async () => {
		const t = tab(withHidden());
		const r = ok<ElementDetail>(await t.ask('get_element', { id: 'Account' }));
		expect((r.element as { name: string }).name).toBe('Account');
		expect(r.info.onDiagrams).toEqual(['d1']);
		expect(Object.keys(r.layouts)).toEqual(['d1']);
		expect((r.relationships as { id: string }[]).map((x) => x.id)).toEqual(['Ghost-Account']);
		const missing = await t.ask('get_element', { id: 'Nobody' });
		expect(missing.ok).toBe(false);
	});

	it('finds by name, kind, stereotype, diagram and hiddenness', async () => {
		const t = tab(withHidden());
		const names = (r: ElementInfo[]) => r.map((e) => e.name).sort();
		expect(names(ok(await t.ask('find', { query: 'acc' })))).toEqual(['Account']);
		expect(names(ok(await t.ask('find', { kind: 'classifier' })))).toEqual([
			'Account',
			'Customer',
			'Ghost'
		]);
		expect(names(ok(await t.ask('find', { stereotype: 'Concept' })))).toEqual(['Ghost']);
		expect(names(ok(await t.ask('find', { kind: 'classifier', diagram: 'd1' })))).toEqual([
			'Account',
			'Customer'
		]);
		expect(ok<ElementInfo[]>(await t.ask('find', { hiddenOnly: true })).map((e) => e.id)).toEqual([
			'Ghost',
			'Ghost-Account'
		]);
	});

	it('describes the selection', async () => {
		const t = tab(sampleProject(), { selection: ['Customer'], editing: true });
		const r = ok<SelectionResult>(await t.ask('get_selection', {}));
		expect(r.selection.map((e) => e.name)).toEqual(['Customer']);
		expect(r.editing).toBe(true);
		expect(r.activeDiagramId).toBe('d1');
	});

	it("reports validation findings in the panel's words", async () => {
		const p = sampleProject();
		p.elements.set('Dup', createClassifier({ id: 'Dup', name: 'Account' }));
		const t = tab(p);
		const r = ok<ValidateResult>(await t.ask('validate', {}));
		const dup = r.findings.filter((f) => f.rule === 'UML002');
		expect(dup.length).toBeGreaterThan(0);
		expect(dup[0].message).toBe('Name is already defined.');
		expect(dup.map((f) => f.element)).toContain('Account');
		expect(ok<ValidateResult>(await tab().ask('validate', {})).findings).toEqual([]);
	});
});

describe('bridge: rendering', () => {
	it('draws the diagram, or part of it, as SVG with the content rectangles', async () => {
		const t = tab();
		const r = ok<RenderResult>(await t.ask('render', { format: 'svg' }));
		expect(r.svg).toMatch(/^<svg/);
		expect(r.svg).toContain('Account');
		expect(r.width).toBeGreaterThan(160);
		const part = ok<RenderResult>(await t.ask('render', { format: 'svg', only: ['Customer'] }));
		expect(part.svg).toContain('Customer');
		expect(part.svg).not.toContain('>Account<');
		expect(part.width).toBeLessThan(r.width);
	});

	it('hands PNG work to the tab, and says so where there is none', async () => {
		const plain = tab();
		const none = await plain.ask('render', {});
		expect(none.ok).toBe(false);
		if (!none.ok) expect(none.error).toMatch(/PNG needs the tab/);
		const seen: unknown[] = [];
		const t = tab(
			sampleProject(),
			{},
			{
				toPng: async (svg, w, h, scale) => {
					seen.push([svg.startsWith('<svg'), w > 0, h > 0, scale]);
					return 'UE5H';
				},
				fontCss: async () => '@font-face{}'
			}
		);
		const r = ok<RenderResult>(await t.ask('render', { scale: 2 }));
		expect(r.png).toBe('UE5H');
		expect(r.format).toBe('png');
		expect(seen).toEqual([[true, true, true, 2]]);
	});
});
