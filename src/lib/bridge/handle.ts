/**
 * What the tab does with a `BridgeRequest` (docs/mcp.md), as pure functions over the model: the
 * client (client.svelte.ts) supplies the stores through `Context`, the tests supply a project and
 * a command stack. Every write is a batch command the caller runs through `projectStore.run`, so
 * an edit from the bridge is one undo step and lands in autosave like any other.
 */
import { serializeAster } from '#lib/aster/index.ts';
import type { BatchArgs } from '#lib/commands/batch.ts';
import {
	PACKAGE_MIN,
	addClassifier,
	addDiagram,
	addNote,
	addPackage,
	addToDiagram,
	connect,
	deleteFromDiagram,
	deleteFromModel,
	flipRelationship,
	linkNote,
	moveToPackage,
	renameClassifier,
	replaceElement,
	setClassifierFlags,
	setClassifierKind,
	setDiagramDefaults,
	setDocumentation,
	setElementText,
	setEnd,
	setNodeFlags,
	setNodePositions,
	setRelationshipKind,
	setRelationshipName,
	setRelationshipStereotype,
	type ClassifierFlags
} from '#lib/commands/index.ts';
import { serialise } from '#lib/commands/registry.ts';
import type { Command, SerialisedCommand } from '#lib/commands/types.ts';
import { NEW_NODE, freePosition, rightOf } from '#lib/canvas/place.ts';
import { diagramToMermaid } from '#lib/export/mermaid.ts';
import { contentRects, diagramToSvg } from '#lib/export/svg.ts';
import { t, type MessageKey } from '#lib/i18n/index.ts';
import { memberFromText, renderMember, type Member, type MemberKind } from '#lib/mdj/expression.ts';
import { newId } from '#lib/model/ids.ts';
import {
	createClassifier,
	createPackage,
	defaultEdgeLayout,
	defaultNodeLayout,
	elementName,
	isAssociationKind
} from '#lib/model/project.ts';
import {
	DEFAULT_DISPLAY_FLAGS,
	type Attribute,
	type Diagram,
	type DisplayFlags,
	type Element,
	type Id,
	type Layout,
	type Literal,
	type Operation,
	type Point,
	type Project
} from '#lib/model/types.ts';
import { validate } from '#lib/model/validate.ts';
import { SOURCE_PATH } from '#lib/mdj/parse.ts';
import { parsePuml, type PError } from '#lib/puml/parse.ts';
import { printDiagram } from '#lib/puml/print.ts';
import { planSync } from '#lib/puml/sync.ts';
import type {
	AddClassifierParams,
	AddNoteParams,
	BridgeRequest,
	BridgeResponse,
	ConnectParams,
	Dialect,
	DisplayParams,
	ElementDetail,
	ElementInfo,
	ErrorCode,
	FindParams,
	LayoutParams,
	Method,
	MoveToPackageParams,
	RenderParams,
	RenderResult,
	Results,
	SetMembersParams,
	Status,
	UpdateParams,
	ValidationFinding
} from './protocol.ts';

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The parts of `Status` only the tab knows (files, route, selection, undo menu). */
export interface UiState {
	file: Status['file'];
	state: Status['state'];
	editor: boolean;
	route: string | null;
	url: string;
	selection: Id[];
	editing: boolean;
	undoLabel: string | null;
	redoLabel: string | null;
}

export interface Context {
	readonly project: Project;
	readonly version: number;
	readonly activeDiagramId: Id;
	/** Where the diagram's nodes are, by id: as drawn when it is the open one, else `modelRects`. */
	rects(diagram: Diagram): ReadonlyMap<Id, Rect>;
	/** Runs one batch and returns its label. */
	run(plan: BatchArgs): string;
	ui(): UiState;
	/** SVG text to base64 PNG bytes; only a browser can (export/image.ts). */
	toPng?(svg: string, width: number, height: number, scale: 1 | 2): Promise<string>;
	/** `@font-face` rules with the paper font inlined, so a PNG renders with it. */
	fontCss?(): Promise<string>;
	// What only the tab can do: its selection, its open diagram, its history, its ELK worker.
	select?(ids: Id[], centre: boolean): void;
	openDiagram?(id: Id): void;
	undo?(): string | null;
	redo?(): string | null;
	/** The canvas's auto-layout (ELK) on `only` (two or more) or the whole diagram; its undo label. */
	layout?(
		diagramId: Id,
		algorithm: NonNullable<LayoutParams['algorithm']>,
		direction: NonNullable<LayoutParams['direction']>,
		only: Id[] | null
	): Promise<string | null>;
}

export class BridgeError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/** A diagram by id, or by name when the name is unique; the active one when `ref` is empty. */
export function diagramOf(project: Project, ref: string | undefined, activeId: Id): Diagram {
	if (!ref) {
		const d = project.diagrams.find((d) => d.id === activeId);
		if (!d) throw new BridgeError('no_diagram', 'The project has no open diagram.');
		return d;
	}
	const byId = project.diagrams.find((d) => d.id === ref);
	if (byId) return byId;
	const byName = project.diagrams.filter((d) => d.name === ref);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1)
		throw new BridgeError(
			'ambiguous',
			`${byName.length} diagrams are named ${ref}: ${byName.map((d) => d.id).join(', ')}. Use an id.`
		);
	throw new BridgeError(
		'no_diagram',
		`No diagram ${ref}. The project has: ${project.diagrams.map((d) => `${d.name} (${d.id})`).join(', ')}.`
	);
}

/** An element by id, or by name when exactly one element has it. */
export function elementOf(project: Project, ref: string): Element {
	const byId = project.elements.get(ref);
	if (byId) return byId;
	const byName = [...project.elements.values()].filter((e) => elementName(e) === ref);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1)
		throw new BridgeError(
			'ambiguous',
			`${byName.length} elements are named ${ref}: ${byName.map((e) => `${e.kind} ${e.id}`).join(', ')}. Use an id.`
		);
	throw new BridgeError('no_element', `No element ${ref} in the model.`);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The unseen content as text, for "does anything still refer to this id": the records Aster keeps
 * of other diagram types, tags and the like. An element's own `#source` record (its original .mdj
 * JSON, kept for the round trip) names its id too and is left out, or every element would count.
 */
const unseen = (project: Project) =>
	JSON.stringify(project.unknown.filter((u) => u.path !== SOURCE_PATH));

const describe = (project: Project, el: Element, unknownText: string): ElementInfo => ({
	id: el.id,
	kind: el.kind,
	name: elementName(el),
	...('stereotype' in el && el.stereotype ? { stereotype: el.stereotype } : {}),
	onDiagrams: project.diagrams.filter((d) => d.elementIds.includes(el.id)).map((d) => d.id),
	inUnknown: unknownText.includes(`"${el.id}"`)
});

/** Elements no diagram shows, with a flag for those that content Aster keeps unseen still names. */
export function hidden(project: Project): ElementInfo[] {
	const shown = new Set(project.diagrams.flatMap((d) => d.elementIds));
	const unknownText = unseen(project);
	return [...project.elements.values()]
		.filter((e) => !shown.has(e.id))
		.map((e) => describe(project, e, unknownText));
}

export function detail(project: Project, ref: string): ElementDetail {
	const el = elementOf(project, ref);
	const layouts: Record<Id, Layout> = {};
	for (const d of project.diagrams) {
		const l = d.layout.get(el.id);
		if (l) layouts[d.id] = plain(l);
	}
	const relationships = [...project.elements.values()].filter(
		(e) =>
			(e.kind === 'relationship' || e.kind === 'link') &&
			(e.sourceId === el.id || e.targetId === el.id)
	);
	return {
		element: plain(el),
		info: describe(project, el, unseen(project)),
		layouts,
		relationships: plain(relationships)
	};
}

export function find(project: Project, p: FindParams, activeId: Id): ElementInfo[] {
	const q = p.query?.toLowerCase();
	const on = p.diagram ? new Set(diagramOf(project, p.diagram, activeId).elementIds) : null;
	const shown = p.hiddenOnly ? new Set(project.diagrams.flatMap((d) => d.elementIds)) : null;
	const unknownText = unseen(project);
	return [...project.elements.values()]
		.filter(
			(e) =>
				(!p.kind || e.kind === p.kind) &&
				(!p.stereotype || ('stereotype' in e && e.stereotype === p.stereotype)) &&
				(!q || elementName(e).toLowerCase().includes(q)) &&
				(!on || on.has(e.id)) &&
				(!shown || !shown.has(e.id))
		)
		.map((e) => describe(project, e, unknownText));
}

/** The Validation panel's findings, worded as it words them. */
export function findings(project: Project): ValidationFinding[] {
	return validate(project).map((f) => {
		const el = project.elements.get(f.elementId);
		const message =
			f.rule === 'ASTER001'
				? t(`validation.ASTER001.${f.detail!}`, { name: f.subject })
				: t(`validation.${f.rule}` as MessageKey);
		return {
			rule: f.rule,
			elementId: f.elementId,
			element: el ? elementName(el) : f.elementId,
			...(f.memberId ? { memberId: f.memberId } : {}),
			subject: f.subject,
			message
		};
	});
}

export function counts(project: Project): Status['counts'] {
	const out = { classifiers: 0, relationships: 0, packages: 0, notes: 0, instances: 0 };
	for (const el of project.elements.values()) {
		if (el.kind === 'classifier') out.classifiers++;
		else if (el.kind === 'relationship') out.relationships++;
		else if (el.kind === 'package') out.packages++;
		else if (el.kind === 'note') out.notes++;
		else if (el.kind === 'instance') out.instances++;
	}
	return out;
}

/**
 * Rectangles for a diagram that is not drawn right now: classifiers at the size their content
 * takes (the export's metrics), everything else as its layout says.
 */
export function modelRects(project: Project, diagram: Diagram): Map<Id, Rect> {
	const out = contentRects(project, diagram);
	for (const [id, l] of diagram.layout)
		if (l.kind === 'node' && !out.has(id)) out.set(id, { x: l.x, y: l.y, w: l.w, h: l.h });
	return out;
}

/**
 * The drawn rectangles, but none shorter than its content: a tab in the background may not have
 * painted the latest members yet, and an export cut through a compartment helps no one.
 */
export function drawnRects(
	drawn: ReadonlyMap<Id, Rect>,
	model: ReadonlyMap<Id, Rect>
): ReadonlyMap<Id, Rect> {
	if (!drawn.size) return model;
	const out = new Map(drawn);
	for (const [id, m] of model) {
		const r = out.get(id);
		if (r && r.h < m.h) out.set(id, { ...r, h: m.h });
	}
	return out;
}

export function textOf(project: Project, diagram: Diagram, dialect: Dialect): string {
	return dialect === 'mermaid'
		? diagramToMermaid(project, diagram)
		: printDiagram(project, diagram);
}

/** The diagram (or `only` its named elements) as SVG, as the Export sheet draws it. */
export function renderSvg(
	project: Project,
	diagram: Diagram,
	rects: ReadonlyMap<Id, Rect>,
	p: Pick<RenderParams, 'only' | 'background'>,
	fontCss?: string
) {
	const only = p.only?.length ? new Set(p.only.map((r) => elementOf(project, r).id)) : null;
	return diagramToSvg(project, diagram, rects, {
		only,
		background: p.background ?? 'white',
		fontCss
	});
}

// ---------------------------------------------------------------------------
// Writing: plans the caller runs as one batch
// ---------------------------------------------------------------------------

/** One model command, run as the bridge's own undo step. */
const asBridgeBatch = (cmd: Command): BatchArgs => ({
	label: t('cmd.bridge', { label: cmd.label }),
	commands: [serialise(cmd)]
});

/**
 * The batch that makes `diagram` match `text`, placed like the Text view places (free space from
 * the top-left corner), labelled as the bridge's; null when the text already matches.
 */
export function planText(
	project: Project,
	diagram: Diagram,
	text: string,
	taken: Iterable<Rect>,
	mint?: () => Id
): { errors: PError[] } | { plan: BatchArgs | null } {
	if (diagram.diagramKind === 'object')
		throw new BridgeError(
			'object_diagram',
			`${diagram.name} is an object diagram; the PlantUML dialect describes class diagrams only.`
		);
	const doc = parsePuml(text);
	if (doc.errors.length) return { errors: doc.errors };
	const rects = [...taken];
	const plan = planSync(project, diagram.id, doc, {
		mint,
		place: () => {
			const at = freePosition({ x: 40, y: 40 }, rects);
			rects.push({ ...at, w: 160, h: 80 });
			return at;
		}
	});
	return { plan: plan && { ...plan, label: t('cmd.bridge', { label: plan.label }) } };
}

/** The parse errors as the Text view words them, one per line. */
export const errorText = (errors: PError[]) =>
	errors.map((e) => t(`text.error.${e.message}`, { line: e.line, name: e.name ?? '' })).join('\n');

/**
 * Views for `refs` on `diagram`: nodes at `at[id]` or in free space, and (unless told not to) an
 * edge for every model relationship whose both ends are then on the diagram. Null when every
 * one of them is there already.
 */
export function planShow(
	project: Project,
	diagram: Diagram,
	refs: string[],
	taken: Iterable<Rect>,
	at: Record<string, Point> = {},
	relationships = true
): { plan: BatchArgs | null; added: Id[] } {
	const rects = [...taken];
	const on = new Set(diagram.elementIds);
	const entries: { id: Id; layout: Layout }[] = [];
	const edges: Element[] = [];
	for (const ref of refs) {
		const el = elementOf(project, ref);
		if (on.has(el.id)) continue;
		if (el.kind === 'relationship' || el.kind === 'link') {
			edges.push(el);
			continue;
		}
		const p = at[el.id] ?? at[ref] ?? freePosition({ x: 40, y: 40 }, rects);
		const layout = defaultNodeLayout(p.x, p.y);
		rects.push({ x: p.x, y: p.y, w: layout.w, h: layout.h });
		entries.push({ id: el.id, layout });
		on.add(el.id);
	}
	if (relationships)
		for (const el of project.elements.values())
			if ((el.kind === 'relationship' || el.kind === 'link') && !on.has(el.id)) edges.push(el);
	for (const el of edges) {
		if (el.kind !== 'relationship' && el.kind !== 'link') continue;
		if (on.has(el.id) || !on.has(el.sourceId) || !on.has(el.targetId)) continue;
		entries.push({ id: el.id, layout: defaultEdgeLayout() });
		on.add(el.id);
	}
	if (!entries.length) return { plan: null, added: [] };
	return {
		plan: asBridgeBatch(addToDiagram(project, { diagramId: diagram.id, entries })),
		added: entries.map((e) => e.id)
	};
}

/** Removal from the model (everything, every view, attached lines) or from one diagram's views. */
export function planDelete(
	project: Project,
	refs: string[],
	from: 'model' | 'diagram',
	diagram?: Diagram
): { plan: BatchArgs | null; ids: Id[] } {
	const ids = [...new Set(refs.map((r) => elementOf(project, r).id))];
	if (from === 'diagram') {
		if (!diagram) throw new BridgeError('no_diagram', 'Removing a view needs a diagram.');
		const on = ids.filter((id) => diagram.elementIds.includes(id));
		if (!on.length) return { plan: null, ids: [] };
		return {
			plan: asBridgeBatch(deleteFromDiagram(project, { diagramId: diagram.id, ids: on })),
			ids: on
		};
	}
	if (!ids.length) return { plan: null, ids: [] };
	return { plan: asBridgeBatch(deleteFromModel(project, { ids })), ids };
}

/** Several commands as the bridge's one undo step, under the first one's label unless told otherwise. */
const batchOf = (cmds: Command[], label = cmds[0].label): BatchArgs => ({
	label: t('cmd.bridge', { label }),
	commands: cmds.map(serialise)
});

/** Key-order-free equality for plain model objects (as puml/sync.ts compares). */
const stable = (v: unknown): string =>
	JSON.stringify(v, (_, x) =>
		x && typeof x === 'object' && !Array.isArray(x)
			? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
			: x
	);

const needsNode = (diagram: Diagram, el: Element) => {
	const l = diagram.layout.get(el.id);
	if (l?.kind !== 'node')
		throw new BridgeError(
			'not_on_diagram',
			`${elementName(el) || el.id} is not drawn on ${diagram.name}; aster_add_to_diagram puts it there first.`
		);
	return l;
};
const bad = (message: string) => new BridgeError('bad_args', message);

/** Where a new node goes: `at` as given, else right of `near`, else free space from the corner. */
export function placeNew(
	project: Project,
	diagram: Diagram,
	rects: ReadonlyMap<Id, Rect>,
	at?: Point,
	near?: string,
	size = NEW_NODE
): Point {
	if (at) return at;
	let from = { x: 40, y: 40 };
	if (near) {
		const el = elementOf(project, near);
		const l = needsNode(diagram, el);
		from = rightOf([rects.get(el.id) ?? { x: l.x, y: l.y, w: l.w, h: l.h }])!;
	}
	return freePosition(from, rects.values(), size);
}

/**
 * The members a list of UML text lines describes, reusing the classifier's own member (its id and
 * documentation) wherever a line still says the same, or sits at the same place (an edit).
 */
export function membersFromLines(
	existing: readonly Member[],
	kind: MemberKind,
	lines: string[],
	mint: () => Id = newId
): Member[] {
	const canon = (text: string) => renderMember(kind, memberFromText(kind, text, 'x'));
	const used = new Set<Member>();
	const out: Member[] = [];
	for (const line of lines) {
		const text = canon(line);
		const exact = existing.find((m) => !used.has(m) && renderMember(kind, m) === text);
		if (exact) {
			used.add(exact);
			out.push(exact);
			continue;
		}
		const at = existing[out.length];
		const prev = at && !used.has(at) ? at : undefined;
		if (prev) used.add(prev);
		out.push(memberFromText(kind, line, prev?.id ?? mint(), prev));
	}
	return out;
}

export function planClassifier(
	project: Project,
	diagram: Diagram,
	p: AddClassifierParams,
	rects: ReadonlyMap<Id, Rect>,
	mint: () => Id = newId
): { id: Id; plan: BatchArgs } {
	if (!p.name?.trim()) throw bad('A classifier needs a name.');
	const id = mint();
	const lines = (kind: MemberKind, ls: string[] | undefined) =>
		(ls ?? []).map((l) => memberFromText(kind, l, mint()));
	const classifier = createClassifier({
		id,
		classifierKind: p.kind ?? 'class',
		name: p.name,
		isAbstract: p.abstract ?? false,
		documentation: p.documentation ?? '',
		...(p.stereotype ? { stereotype: p.stereotype } : {}),
		attributes: lines('attribute', p.attributes) as Attribute[],
		operations: lines('operation', p.operations) as Operation[],
		literals: lines('literal', p.literals) as Literal[]
	});
	const at = placeNew(project, diagram, rects, p.at, p.near);
	return { id, plan: batchOf([addClassifier(project, { diagramId: diagram.id, classifier, at })]) };
}

export function planMembers(
	project: Project,
	p: SetMembersParams,
	mint: () => Id = newId
): { id: Id; plan: BatchArgs | null } {
	const el = elementOf(project, p.id);
	if (el.kind !== 'classifier')
		throw bad(`${elementName(el)} is a ${el.kind}; only classifiers have members.`);
	const next = { ...el };
	if (p.attributes)
		next.attributes = membersFromLines(
			el.attributes,
			'attribute',
			p.attributes,
			mint
		) as Attribute[];
	if (p.operations)
		next.operations = membersFromLines(
			el.operations,
			'operation',
			p.operations,
			mint
		) as Operation[];
	if (p.literals)
		next.literals = membersFromLines(el.literals, 'literal', p.literals, mint) as Literal[];
	if (stable(next) === stable(el)) return { id: el.id, plan: null };
	return { id: el.id, plan: batchOf([replaceElement(project, { element: next })]) };
}

export function planConnect(
	project: Project,
	diagram: Diagram,
	p: ConnectParams,
	mint: () => Id = newId
): { id: Id; plan: BatchArgs } {
	const source = elementOf(project, p.source);
	const target = elementOf(project, p.target);
	for (const el of [source, target]) {
		if (el.kind !== 'classifier')
			throw bad(`${elementName(el)} is a ${el.kind}; relationships join classifiers.`);
		needsNode(diagram, el);
	}
	if ((p.sourceEnd || p.targetEnd) && !isAssociationKind(p.kind))
		throw bad(`A ${p.kind} has no ends; roles and multiplicities belong to associations.`);
	const id = mint();
	const cmds: Command[] = [
		connect(project, {
			diagramId: diagram.id,
			id,
			sourceId: source.id,
			targetId: target.id,
			kind: p.kind
		})
	];
	if (p.name) cmds.push(setRelationshipName(project, { id, name: p.name }));
	if (p.stereotype) cmds.push(setRelationshipStereotype(project, { id, stereotype: p.stereotype }));
	if (p.sourceEnd) cmds.push(setEnd(project, { id, end: 'source', patch: p.sourceEnd }));
	if (p.targetEnd) cmds.push(setEnd(project, { id, end: 'target', patch: p.targetEnd }));
	return { id, plan: batchOf(cmds) };
}

const ALLOWED: Record<Element['kind'], (keyof UpdateParams)[]> = {
	classifier: [
		'name',
		'stereotype',
		'abstract',
		'leaf',
		'visibility',
		'classifierKind',
		'documentation'
	],
	relationship: [
		'name',
		'stereotype',
		'relationshipKind',
		'flip',
		'sourceEnd',
		'targetEnd',
		'documentation'
	],
	note: ['text'],
	text: ['text'],
	package: ['name', 'documentation'],
	instance: ['name', 'stereotype', 'documentation'],
	link: ['name', 'documentation']
};

export function planUpdate(project: Project, p: UpdateParams): { id: Id; plan: BatchArgs | null } {
	const el = elementOf(project, p.id);
	const given = (Object.keys(p) as (keyof UpdateParams)[]).filter(
		(k) => k !== 'id' && p[k] !== undefined
	);
	const wrong = given.filter((k) => !ALLOWED[el.kind].includes(k));
	if (wrong.length)
		throw bad(
			`${elementName(el) || el.id} is a ${el.kind}: it has no ${wrong.join(', ')}. It takes ${ALLOWED[el.kind].join(', ')}.`
		);
	const cmds: Command[] = [];
	const id = el.id;
	switch (el.kind) {
		case 'classifier': {
			if (p.name !== undefined && p.name !== el.name)
				cmds.push(renameClassifier(project, { id, name: p.name }));
			// Only what differs, so an "already so" asks for no undo step.
			const flags: ClassifierFlags = {};
			if (p.abstract !== undefined && p.abstract !== el.isAbstract) flags.isAbstract = p.abstract;
			if (p.leaf !== undefined && p.leaf !== el.isLeaf) flags.isLeaf = p.leaf;
			if (p.visibility !== undefined && p.visibility !== el.visibility)
				flags.visibility = p.visibility;
			if (p.stereotype !== undefined && p.stereotype !== (el.stereotype ?? null))
				flags.stereotype = p.stereotype;
			if (Object.keys(flags).length) cmds.push(setClassifierFlags(project, { id, flags }));
			if (p.classifierKind !== undefined && p.classifierKind !== el.classifierKind)
				cmds.push(setClassifierKind(project, { id, classifierKind: p.classifierKind }));
			break;
		}
		case 'relationship': {
			if (p.name !== undefined)
				cmds.push(setRelationshipName(project, { id, name: p.name || null }));
			if (p.stereotype !== undefined)
				cmds.push(setRelationshipStereotype(project, { id, stereotype: p.stereotype }));
			if (p.relationshipKind !== undefined && p.relationshipKind !== el.relationshipKind)
				cmds.push(setRelationshipKind(project, { id, relationshipKind: p.relationshipKind }));
			if (p.sourceEnd) cmds.push(setEnd(project, { id, end: 'source', patch: p.sourceEnd }));
			if (p.targetEnd) cmds.push(setEnd(project, { id, end: 'target', patch: p.targetEnd }));
			if (p.flip) cmds.push(flipRelationship(project, { id }));
			break;
		}
		case 'note':
		case 'text':
			if (p.text !== undefined && p.text !== el.text)
				cmds.push(setElementText(project, { id, text: p.text }));
			break;
		default: {
			// Packages, instances and links rename through replaceElement (as the inspector does).
			const next = { ...el } as Element & { name?: string; stereotype?: string };
			if (p.name !== undefined) next.name = p.name;
			if (p.stereotype !== undefined && el.kind === 'instance') {
				if (p.stereotype === null) delete next.stereotype;
				else next.stereotype = p.stereotype;
			}
			if (stable(next) !== stable(el)) cmds.push(replaceElement(project, { element: next }));
		}
	}
	if (
		p.documentation !== undefined &&
		'documentation' in el &&
		p.documentation !== el.documentation
	)
		cmds.push(setDocumentation(project, { id, documentation: p.documentation }));
	if (!cmds.length) return { id, plan: null };
	return {
		id,
		plan: batchOf(
			cmds,
			cmds.length === 1 ? cmds[0].label : t('cmd.editElement', { name: elementName(el) })
		)
	};
}

export function planNote(
	project: Project,
	diagram: Diagram,
	p: AddNoteParams,
	rects: ReadonlyMap<Id, Rect>,
	mint: () => Id = newId
): { id: Id; plan: BatchArgs } {
	const id = mint();
	const at = placeNew(project, diagram, rects, p.at, undefined, { w: 120, h: 84 });
	const cmds: Command[] = [
		addNote(project, {
			diagramId: diagram.id,
			note: { kind: 'note', id, text: p.text, linkedIds: [] },
			at
		})
	];
	for (const ref of p.linkTo ?? []) {
		const target = elementOf(project, ref);
		cmds.push(linkNote(project, { noteId: id, targetId: target.id }));
	}
	return { id, plan: batchOf(cmds) };
}

export function planPackage(
	project: Project,
	diagram: Diagram,
	p: MoveToPackageParams,
	rects: ReadonlyMap<Id, Rect>,
	mint: () => Id = newId
): { packageId: Id | null; plan: BatchArgs | null } {
	const ids = [...new Set(p.ids.map((r) => elementOf(project, r).id))];
	const cmds: Command[] = [];
	let to: Id | null = null;
	if (p.package !== null) {
		let pkg: Element | undefined;
		try {
			pkg = elementOf(project, p.package);
		} catch (e) {
			if (!(e instanceof BridgeError && e.code === 'no_element' && p.create)) throw e;
		}
		if (pkg && pkg.kind !== 'package')
			throw bad(`${elementName(pkg)} is a ${pkg.kind}, not a package.`);
		if (pkg) to = pkg.id;
		else {
			to = mint();
			const at = p.at ?? freePosition({ x: 40, y: 40 }, rects.values(), PACKAGE_MIN);
			cmds.push(
				addPackage(project, {
					diagramId: diagram.id,
					pkg: createPackage({ id: to, name: p.package }),
					at
				})
			);
		}
	}
	const moves = ids.filter((id) => {
		const el = project.elements.get(id)!;
		const owner = 'packageId' in el ? el.packageId : 'parentId' in el ? el.parentId : undefined;
		return (owner ?? null) !== to;
	});
	if (moves.length) cmds.push(moveToPackage(project, { moves: moves.map((id) => ({ id, to })) }));
	if (!cmds.length) return { packageId: to, plan: null };
	return { packageId: to, plan: batchOf(cmds) };
}

export function planArrange(
	project: Project,
	diagram: Diagram,
	positions: Record<string, Point>
): BatchArgs | null {
	const moves = Object.entries(positions).flatMap(([ref, at]) => {
		const el = elementOf(project, ref);
		const l = needsNode(diagram, el);
		return l.x === at.x && l.y === at.y ? [] : [{ id: el.id, x: at.x, y: at.y }];
	});
	if (!moves.length) return null;
	return batchOf([setNodePositions(project, { diagramId: diagram.id, positions: moves })]);
}

export function planDisplay(
	project: Project,
	diagram: Diagram,
	p: DisplayParams
): BatchArgs | null {
	const keys = Object.keys(p.flags ?? {}) as (keyof DisplayFlags)[];
	const unknown = keys.filter((k) => !(k in DEFAULT_DISPLAY_FLAGS));
	if (unknown.length)
		throw bad(
			`No display flag ${unknown.join(', ')}. The flags are ${Object.keys(DEFAULT_DISPLAY_FLAGS).join(', ')}.`
		);
	if (!keys.length) return null;
	if (!p.ids?.length)
		return batchOf([setDiagramDefaults(project, { diagramId: diagram.id, patch: p.flags })]);
	const cmds = p.ids.map((ref) => {
		const el = elementOf(project, ref);
		needsNode(diagram, el);
		return setNodeFlags(project, { diagramId: diagram.id, id: el.id, patch: p.flags });
	});
	return batchOf(cmds);
}

export function planRun(label: string, commands: unknown): BatchArgs {
	if (!label?.trim()) throw bad('A label for the undo menu is needed.');
	if (
		!Array.isArray(commands) ||
		!commands.length ||
		!commands.every(
			(c) => c && typeof c === 'object' && typeof (c as SerialisedCommand).id === 'string'
		)
	)
		throw bad('commands must be a non-empty list of { id, args }; see aster://commands.');
	return { label: t('cmd.bridge', { label }), commands: commands as SerialisedCommand[] };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function statusOf(ctx: Context): Status {
	const p = ctx.project;
	const ui = ctx.ui();
	return {
		project: { id: p.id, name: p.name },
		file: ui.file,
		state: ui.state,
		editor: ui.editor,
		route: ui.route,
		url: ui.url,
		version: ctx.version,
		activeDiagramId: ctx.activeDiagramId,
		diagrams: p.diagrams.map((d) => ({
			id: d.id,
			name: d.name,
			diagramKind: d.diagramKind,
			elements: d.elementIds.length
		})),
		counts: counts(p),
		selection: ui.selection.flatMap((id) => {
			const el = p.elements.get(id);
			return el ? [{ id, kind: el.kind, name: elementName(el) }] : [];
		}),
		editing: ui.editing,
		undoLabel: ui.undoLabel,
		redoLabel: ui.redoLabel
	};
}

const stale = (ctx: Context, expectVersion: number | undefined, verb: string) => {
	if (expectVersion !== undefined && expectVersion !== ctx.version)
		throw new BridgeError(
			'stale',
			`The model is at version ${ctx.version}, not ${expectVersion}: it changed since you read it. Read it again before ${verb}.`
		);
};

async function result<M extends Method>(req: BridgeRequest<M>, ctx: Context): Promise<Results[M]> {
	const needEditor = () => {
		if (!ctx.ui().editor)
			throw new BridgeError(
				'no_editor',
				'The tab shows the welcome page, not a diagram. Open a project there first.'
			);
	};
	const r = req as BridgeRequest;
	switch (r.method) {
		case 'status':
			return statusOf(ctx) as Results[M];
		case 'get_text': {
			needEditor();
			const { diagram: ref, dialect = 'puml' } = (r as BridgeRequest<'get_text'>).params;
			const d = diagramOf(ctx.project, ref, ctx.activeDiagramId);
			return {
				diagramId: d.id,
				diagram: d.name,
				dialect,
				text: textOf(ctx.project, d, dialect),
				version: ctx.version
			} as Results[M];
		}
		case 'set_text': {
			needEditor();
			const { diagram: ref, text, expectVersion } = (r as BridgeRequest<'set_text'>).params;
			stale(ctx, expectVersion, 'writing');
			const d = diagramOf(ctx.project, ref, ctx.activeDiagramId);
			const out = planText(ctx.project, d, text, ctx.rects(d).values());
			if ('errors' in out) throw new BridgeError('syntax', errorText(out.errors));
			const label = out.plan ? ctx.run(out.plan) : null;
			return {
				diagramId: d.id,
				changed: out.plan !== null,
				label,
				version: ctx.version,
				text: printDiagram(ctx.project, d)
			} as Results[M];
		}
		case 'get_project': {
			const { layout = false } = (r as BridgeRequest<'get_project'>).params;
			const { project } = serializeAster(ctx.project);
			const trimmed = layout
				? project
				: {
						...project,
						diagrams: project.diagrams.map((d) =>
							Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'layout'))
						)
					};
			return { project: trimmed, hidden: hidden(ctx.project), version: ctx.version } as Results[M];
		}
		case 'get_element': {
			const { id } = (r as BridgeRequest<'get_element'>).params;
			return detail(ctx.project, id) as Results[M];
		}
		case 'find':
			return find(
				ctx.project,
				(r as BridgeRequest<'find'>).params,
				ctx.activeDiagramId
			) as Results[M];
		case 'get_selection': {
			const ui = ctx.ui();
			const unknownText = unseen(ctx.project);
			return {
				selection: ui.selection.flatMap((id) => {
					const el = ctx.project.elements.get(id);
					return el ? [describe(ctx.project, el, unknownText)] : [];
				}),
				editing: ui.editing,
				activeDiagramId: ctx.activeDiagramId,
				version: ctx.version
			} as Results[M];
		}
		case 'validate':
			return { findings: findings(ctx.project), version: ctx.version } as Results[M];
		case 'render': {
			needEditor();
			const p = (r as BridgeRequest<'render'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const format = p.format ?? 'png';
			const fontCss = format === 'png' ? await ctx.fontCss?.() : undefined;
			const { svg, width, height } = renderSvg(ctx.project, d, ctx.rects(d), p, fontCss);
			const out: RenderResult = { diagramId: d.id, format, width, height, version: ctx.version };
			if (format === 'svg') out.svg = svg;
			else {
				if (!ctx.toPng)
					throw new BridgeError('failed', 'PNG needs the tab; ask for format "svg" here.');
				out.png = await ctx.toPng(svg, width, height, p.scale ?? 1);
			}
			return out as Results[M];
		}
		case 'add_to_diagram': {
			needEditor();
			const {
				diagram: ref,
				ids,
				at,
				relationships
			} = (r as BridgeRequest<'add_to_diagram'>).params;
			const d = diagramOf(ctx.project, ref, ctx.activeDiagramId);
			const out = planShow(ctx.project, d, ids, ctx.rects(d).values(), at, relationships);
			const label = out.plan ? ctx.run(out.plan) : null;
			return { diagramId: d.id, added: out.added, label, version: ctx.version } as Results[M];
		}
		case 'delete': {
			needEditor();
			const { ids, from, diagram: ref, expectVersion } = (r as BridgeRequest<'delete'>).params;
			stale(ctx, expectVersion, 'deleting');
			const d = from === 'diagram' ? diagramOf(ctx.project, ref, ctx.activeDiagramId) : undefined;
			const out = planDelete(ctx.project, ids, from, d);
			const label = out.plan ? ctx.run(out.plan) : null;
			return { deleted: out.ids, label, version: ctx.version } as Results[M];
		}
		case 'add_classifier': {
			needEditor();
			const p = (r as BridgeRequest<'add_classifier'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const { id, plan } = planClassifier(ctx.project, d, p, ctx.rects(d));
			return { id, label: ctx.run(plan), version: ctx.version } as Results[M];
		}
		case 'set_members': {
			needEditor();
			const { id, plan } = planMembers(ctx.project, (r as BridgeRequest<'set_members'>).params);
			return { id, label: plan ? ctx.run(plan) : null, version: ctx.version } as Results[M];
		}
		case 'connect': {
			needEditor();
			const p = (r as BridgeRequest<'connect'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const { id, plan } = planConnect(ctx.project, d, p);
			return { id, label: ctx.run(plan), version: ctx.version } as Results[M];
		}
		case 'update': {
			needEditor();
			const { id, plan } = planUpdate(ctx.project, (r as BridgeRequest<'update'>).params);
			return { id, label: plan ? ctx.run(plan) : null, version: ctx.version } as Results[M];
		}
		case 'add_note': {
			needEditor();
			const p = (r as BridgeRequest<'add_note'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const { id, plan } = planNote(ctx.project, d, p, ctx.rects(d));
			return { id, label: ctx.run(plan), version: ctx.version } as Results[M];
		}
		case 'move_to_package': {
			needEditor();
			const p = (r as BridgeRequest<'move_to_package'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const { packageId, plan } = planPackage(ctx.project, d, p, ctx.rects(d));
			return { packageId, label: plan ? ctx.run(plan) : null, version: ctx.version } as Results[M];
		}
		case 'arrange': {
			needEditor();
			const p = (r as BridgeRequest<'arrange'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const plan = planArrange(ctx.project, d, p.positions ?? {});
			return { label: plan ? ctx.run(plan) : null, version: ctx.version } as Results[M];
		}
		case 'display': {
			needEditor();
			const p = (r as BridgeRequest<'display'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const plan = planDisplay(ctx.project, d, p);
			return { label: plan ? ctx.run(plan) : null, version: ctx.version } as Results[M];
		}
		case 'layout': {
			needEditor();
			const p = (r as BridgeRequest<'layout'>).params;
			const d = diagramOf(ctx.project, p.diagram, ctx.activeDiagramId);
			const only = p.only?.length ? p.only.map((ref) => elementOf(ctx.project, ref).id) : null;
			if (only && only.length < 2)
				throw bad('`only` needs two or more elements; leave it out for the whole diagram.');
			if (!ctx.layout)
				throw new BridgeError('failed', 'Auto-layout runs in the tab; none is here.');
			const label = await ctx.layout(d.id, p.algorithm ?? 'layered', p.direction ?? 'DOWN', only);
			return { label, version: ctx.version } as Results[M];
		}
		case 'select': {
			needEditor();
			const p = (r as BridgeRequest<'select'>).params;
			const ids = (p.ids ?? []).map((ref) => elementOf(ctx.project, ref).id);
			if (!ctx.select)
				throw new BridgeError('failed', 'Selecting happens in the tab; none is here.');
			ctx.select(ids, p.centre ?? false);
			return { selection: ids, version: ctx.version } as Results[M];
		}
		case 'open_diagram': {
			needEditor();
			const d = diagramOf(
				ctx.project,
				(r as BridgeRequest<'open_diagram'>).params.diagram,
				ctx.activeDiagramId
			);
			if (!ctx.openDiagram)
				throw new BridgeError('failed', 'Opening a diagram happens in the tab; none is here.');
			ctx.openDiagram(d.id);
			return { diagramId: d.id, version: ctx.version } as Results[M];
		}
		case 'add_diagram': {
			needEditor();
			const p = (r as BridgeRequest<'add_diagram'>).params;
			if (!p.name?.trim()) throw bad('A diagram needs a name.');
			const diagramId = newId();
			const label = ctx.run(
				batchOf([
					addDiagram(ctx.project, { diagramId, name: p.name, diagramKind: p.kind ?? 'class' })
				])
			);
			if (p.open) ctx.openDiagram?.(diagramId);
			return { diagramId, label, version: ctx.version } as Results[M];
		}
		case 'undo':
		case 'redo': {
			needEditor();
			const step = r.method === 'undo' ? ctx.undo : ctx.redo;
			if (!step) throw new BridgeError('failed', 'History lives in the tab; none is here.');
			return { label: step(), version: ctx.version } as Results[M];
		}
		case 'run': {
			needEditor();
			const p = (r as BridgeRequest<'run'>).params;
			const plan = planRun(p.label, p.commands);
			return { label: ctx.run(plan), version: ctx.version } as Results[M];
		}
		default:
			throw new BridgeError('unknown_method', `Unknown method ${String(r.method)}.`);
	}
}

/** One request to one response; never throws. */
export async function handle(req: BridgeRequest, ctx: Context): Promise<BridgeResponse> {
	try {
		return { id: req.id, ok: true, version: ctx.version, result: await result(req, ctx) };
	} catch (e) {
		const code = e instanceof BridgeError ? e.code : 'failed';
		const error = e instanceof Error ? e.message : String(e);
		return { id: req.id, ok: false, code, error, version: ctx.version };
	}
}
