/**
 * Concept graphs (owner's request, 2026-11-15; DECISIONS.md): a diagram kind that draws the same
 * classifiers as named boxes and reads each association as a sentence, the role names as verbs.
 * The kind is a StarUML Tag on a UMLClassDiagram in .mdj, so the file opens there unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
	conceptDirection,
	conceptDirections,
	conceptLabelsFor,
	conceptMarkersFor,
	navigabilityFor
} from '#lib/canvas/edges/notation.ts';
import { Stack, setDiagramKind } from '#lib/commands/index.ts';
import { contentRects, diagramToSvg } from '#lib/export/svg.ts';
import { CONCEPT_TAG, isConceptTag, parseMdjText } from '#lib/mdj/parse.ts';
import { serializeMdj } from '#lib/mdj/serialize.ts';
import { parseAster, serializeAsterText } from '#lib/aster/index.ts';
import {
	CONCEPT_DISPLAY_FLAGS,
	createClassifier,
	createDiagram,
	createProject,
	createRelationship,
	defaultEdgeLayout,
	defaultEnd,
	defaultNodeLayout
} from '#lib/model/project.ts';
import { DEFAULT_DISPLAY_FLAGS, type Navigability, type Project } from '#lib/model/types.ts';
import { structural } from './helpers.ts';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
function all(o: unknown, out: J[] = []): J[] {
	if (Array.isArray(o)) o.forEach((v) => all(v, out));
	else if (isObj(o)) {
		out.push(o);
		for (const [k, v] of Object.entries(o)) if (k !== '_parent') all(v, out);
	}
	return out;
}

/** Sales Plan steers Account Manager; Account Manager works according to Sales Plan. */
function association(
	roles: [string | undefined, string | undefined],
	nav: [Navigability, Navigability] = ['unspecified', 'unspecified'],
	kind: 'association' | 'composition' = 'association'
) {
	return createRelationship({
		id: 'r',
		relationshipKind: kind,
		sourceId: 'plan',
		targetId: 'manager',
		sourceEnd: { ...defaultEnd(), role: roles[0], navigable: nav[0], multiplicity: '0..*' },
		targetEnd: { ...defaultEnd(), role: roles[1], navigable: nav[1], multiplicity: '1' }
	});
}

/** A two-concept project with one association, drawn on a concept graph. */
function conceptProject(): Project {
	const project = createProject({ id: 'p', name: 'CXM' });
	const graph = createDiagram({ id: 'g', name: 'Sales Plan', diagramKind: 'concept' });
	project.diagrams.push(graph);
	const plan = createClassifier({ id: 'plan', name: 'Sales Plan', stereotype: 'Concept' });
	const manager = createClassifier({ id: 'manager', name: 'Account Manager', stereotype: 'Role' });
	const rel = association(['steers', 'works according to']);
	for (const el of [plan, manager, rel]) project.elements.set(el.id, el);
	graph.elementIds.push('plan', 'manager', 'r');
	graph.layout.set('plan', defaultNodeLayout(40, 40));
	graph.layout.set('manager', defaultNodeLayout(360, 40));
	graph.layout.set('r', defaultEdgeLayout());
	return project;
}

describe('concept graph notation', () => {
	it('reads both ways with a verb on each end, and nothing said about navigability', () => {
		const r = association(['steers', 'works according to']);
		expect(conceptDirections(r)).toEqual({ forward: true, backward: true });
		expect(conceptMarkersFor(r)).toMatchObject({ start: 'arrow', end: 'arrow', dots: [] });
		const labels = conceptLabelsFor(r, CONCEPT_DISPLAY_FLAGS);
		expect(labels.map((l) => [l.key, l.at, l.lines[0]])).toEqual([
			['sourceRole', 'mid', 'steers'],
			['targetRole', 'mid', 'works according to']
		]);
		// Multiplicities start hidden on a graph; the display toggle brings them back at the ends.
		expect(conceptLabelsFor(r, DEFAULT_DISPLAY_FLAGS).map((l) => l.key)).toEqual([
			'sourceRole',
			'targetRole',
			'sourceMultiplicity',
			'targetMultiplicity'
		]);
	});

	it('one verb reads one way, with one arrow and that verb alone', () => {
		const r = association(['steers', undefined]);
		expect(conceptDirections(r)).toEqual({ forward: true, backward: false });
		expect(conceptMarkersFor(r)).toMatchObject({ start: null, end: 'arrow' });
		expect(conceptLabelsFor(r, CONCEPT_DISPLAY_FLAGS).map((l) => l.lines[0])).toEqual(['steers']);
		const back = association([undefined, 'works according to']);
		expect(conceptMarkersFor(back)).toMatchObject({ start: 'arrow', end: null });
	});

	it('navigability, once set, decides: a not navigable end closes its reading and hides that verb', () => {
		const r = association(['steers', 'works according to'], ['notNavigable', 'unspecified']);
		expect(conceptDirection(r)).toBe('forward');
		expect(conceptLabelsFor(r, CONCEPT_DISPLAY_FLAGS).map((l) => l.lines[0])).toEqual(['steers']);
		// Both ends navigable: both ways, even with one verb (the inspector's "Both ways").
		const both = association(['steers', undefined], ['navigable', 'navigable']);
		expect(conceptDirection(both)).toBe('both');
		expect(conceptMarkersFor(both)).toMatchObject({ start: 'arrow', end: 'arrow' });
		// Neither way: a plain line that still carries both verbs.
		const none = association(['steers', 'works according to'], ['notNavigable', 'notNavigable']);
		expect(conceptDirection(none)).toBeNull();
		expect(conceptMarkersFor(none)).toMatchObject({ start: null, end: null });
		expect(conceptLabelsFor(none, CONCEPT_DISPLAY_FLAGS)).toHaveLength(2);
	});

	it('the inspector choices round-trip through navigability', () => {
		for (const d of ['both', 'forward', 'backward'] as const) {
			const nav = navigabilityFor(d);
			expect(conceptDirection(association(['a', 'b'], [nav.source, nav.target]))).toBe(d);
		}
	});

	it('a composition draws as a plain arrow, no diamond; a generalization keeps its triangle', () => {
		const part = association(
			['is part of', undefined],
			['unspecified', 'unspecified'],
			'composition'
		);
		expect(conceptMarkersFor(part)).toMatchObject({ start: null, end: 'arrow' });
		const gen = createRelationship({
			relationshipKind: 'generalization',
			sourceId: 'a',
			targetId: 'b'
		});
		expect(conceptMarkersFor(gen)).toMatchObject({ end: 'triangle' });
		expect(conceptLabelsFor(gen, CONCEPT_DISPLAY_FLAGS)).toEqual([]);
	});
});

describe('concept graph diagrams', () => {
	it('a new concept graph starts with the notation’s defaults', () => {
		const d = createDiagram({ diagramKind: 'concept' });
		expect(d.defaults).toEqual(CONCEPT_DISPLAY_FLAGS);
		expect(d.defaults.suppressAttributes).toBe(true);
		expect(d.defaults.showMultiplicity).toBe(false);
		expect(d.defaults.stereotypeDisplay).toBe('none');
		expect(createDiagram().defaults).toEqual(DEFAULT_DISPLAY_FLAGS);
	});

	it('setDiagramKind switches a class diagram to a graph and back, defaults included, in one undo step', () => {
		const project = conceptProject();
		const classDiagram = createDiagram({ id: 'c', name: 'Classes' });
		classDiagram.defaults.showVisibility = false;
		project.diagrams.push(classDiagram);
		const stack = new Stack(() => project);
		const before = structural(project);
		const label = stack.run(setDiagramKind(project, { diagramId: 'c', diagramKind: 'concept' }));
		expect(label).toBe('show diagram as concept graph');
		expect(classDiagram.diagramKind).toBe('concept');
		expect(classDiagram.defaults).toEqual(CONCEPT_DISPLAY_FLAGS);
		stack.undo();
		expect(structural(project)).toEqual(before);
		expect(classDiagram.defaults.showVisibility).toBe(false);
		const object = createDiagram({ id: 'o', name: 'Objects', diagramKind: 'object' });
		project.diagrams.push(object);
		expect(() =>
			stack.run(setDiagramKind(project, { diagramId: 'o', diagramKind: 'concept' }))
		).toThrow();
	});

	it('the .aster format keeps the kind and the tag it will write to .mdj', () => {
		const project = conceptProject();
		const text = JSON.stringify(serializeMdj(project)); // puts the Tag among the unknowns
		const { project: fromMdj } = parseMdjText(text);
		const { project: back } = parseAster(JSON.parse(serializeAsterText(fromMdj)));
		expect(back.diagrams[0].diagramKind).toBe('concept');
		expect(JSON.stringify(serializeMdj(back))).toBe(text);
	});
});

describe('concept graphs in .mdj', () => {
	it('writes a UMLClassDiagram with the concept Tag, which StarUML keeps and Aster reads back', () => {
		const project = conceptProject();
		const json = serializeMdj(project);
		const diagram = all(json).find((o) => o._type === 'UMLClassDiagram')!;
		expect(diagram.name).toBe('Sales Plan');
		const tags = diagram.tags as J[];
		expect(tags).toHaveLength(1);
		expect(tags[0]).toMatchObject({
			_type: 'Tag',
			name: CONCEPT_TAG,
			kind: 'string',
			value: 'concept'
		});
		expect(isConceptTag(tags[0])).toBe(true);
		// The classes' views suppress their compartments, so StarUML shows named boxes too.
		const view = all(json).find((o) => o._type === 'UMLClassView')!;
		expect(view.suppressAttributes).toBe(true);
		expect(view.suppressOperations).toBe(true);

		const text = JSON.stringify(json);
		const { project: back } = parseMdjText(text);
		expect(back.diagrams[0].diagramKind).toBe('concept');
		// Saving again keeps the tag and its id: nothing drifts.
		expect(JSON.stringify(serializeMdj(back))).toBe(text);
	});

	it('turning the graph back into a class diagram drops the tag, and a plain file reads as class', () => {
		const project = conceptProject();
		const text = JSON.stringify(serializeMdj(project));
		const { project: back } = parseMdjText(text);
		back.diagrams[0].diagramKind = 'class';
		const json = serializeMdj(back);
		const diagram = all(json).find((o) => o._type === 'UMLClassDiagram')!;
		expect(diagram.tags).toBeUndefined();
		expect(all(json).some(isConceptTag)).toBe(false);
		const { project: again } = parseMdjText(JSON.stringify(json));
		expect(again.diagrams[0].diagramKind).toBe('class');
	});

	it('another tag on the diagram survives beside the concept tag', () => {
		const project = conceptProject();
		const json = serializeMdj(project);
		const diagram = all(json).find((o) => o._type === 'UMLClassDiagram')!;
		(diagram.tags as J[]).unshift({
			_type: 'Tag',
			_id: 'other-tag',
			_parent: { $ref: 'g' },
			name: 'owner',
			kind: 'string',
			value: 'sales'
		});
		const { project: back } = parseMdjText(JSON.stringify(json));
		expect(back.diagrams[0].diagramKind).toBe('concept');
		const out = all(serializeMdj(back)).find((o) => o._type === 'UMLClassDiagram')!;
		expect((out.tags as J[]).map((t) => t.name)).toEqual(['owner', CONCEPT_TAG]);
	});
});

describe('concept graphs as SVG', () => {
	it('draws rounded boxes with the name alone and the verbs along the arrow', () => {
		const project = conceptProject();
		const diagram = project.diagrams[0];
		const rects = contentRects(project, diagram);
		expect(rects.get('plan')).toMatchObject({ w: 160, h: 48 });
		const { svg } = diagramToSvg(project, diagram, rects, { background: 'white' });
		expect((svg.match(/<g class="concept"/g) ?? []).length).toBe(2);
		expect(svg).toContain('rx="12"');
		expect(svg).not.toContain('«Concept»');
		expect(svg).toContain('>steers<');
		expect(svg).toContain('>works according to<');
		expect(svg).not.toContain('>0..*<');
		expect(svg).toContain('marker-start="url(#aster-m-arrow)"');
		expect(svg).toContain('marker-end="url(#aster-m-arrow)"');
	});

	it('a long name wraps inside the box and the box grows to hold it', () => {
		const project = conceptProject();
		const diagram = project.diagrams[0];
		const c = project.elements.get('plan')!;
		if (c.kind === 'classifier') c.name = 'Skill Development Plan for the Whole Market';
		diagram.layout.set('plan', { kind: 'node', x: 0, y: 0, w: 120, h: 0 });
		const r = contentRects(project, diagram).get('plan')!;
		expect(r.w).toBe(120);
		expect(r.h).toBeGreaterThan(48);
	});
});
