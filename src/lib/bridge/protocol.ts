/**
 * The bridge between the dev server's MCP endpoint and the open tab (docs/mcp.md). The plugin
 * asks with a `BridgeRequest` over Vite's HMR socket, the tab answers with a `BridgeResponse`,
 * and volunteers a `Hello` when it connects, gains focus or opens a project, and a `Changed`
 * after every command. Types only; both sides import this file.
 */
import type { SerialisedCommand } from '#lib/commands/types.ts';
import type {
	ClassifierKind,
	DiagramKind,
	DisplayFlags,
	Id,
	Navigability,
	RelationshipKind,
	Visibility
} from '#lib/model/types.ts';

export type Dialect = 'puml' | 'mermaid';

/** Who the tab is, sent on connect, on focus and whenever a project or diagram opens. */
export interface Hello {
	projectId: Id;
	project: string;
	diagramId: Id;
	diagram: string;
	/** The `/design/<slug>` the tab shows; null on the welcome page. */
	route: string | null;
	url: string;
	version: number;
}

/** One model version: what the last command was, as the undo menu names it. */
export interface Changed {
	version: number;
	label: string | null;
	diagramId: Id;
}

export interface DiagramInfo {
	id: Id;
	name: string;
	diagramKind: DiagramKind;
	elements: number;
}
export interface SelectedInfo {
	id: Id;
	kind: string;
	name: string;
}
export interface Status {
	project: { id: Id; name: string };
	/** The file ⌘S writes, when the project has one. */
	file: { name: string; format: 'mdj' | 'aster' } | null;
	state: 'saved' | 'unsaved' | 'never' | 'new';
	/** False on the welcome page: there is no diagram to read or write there. */
	editor: boolean;
	route: string | null;
	url: string;
	version: number;
	activeDiagramId: Id;
	diagrams: DiagramInfo[];
	counts: {
		classifiers: number;
		relationships: number;
		packages: number;
		notes: number;
		instances: number;
	};
	selection: SelectedInfo[];
	/** Something is being edited inline right now. */
	editing: boolean;
	undoLabel: string | null;
	redoLabel: string | null;
}
export interface TextResult {
	diagramId: Id;
	diagram: string;
	dialect: Dialect;
	text: string;
	version: number;
}
export interface SetTextResult {
	diagramId: Id;
	/** False when the text already matched the diagram: nothing ran, nothing to undo. */
	changed: boolean;
	label: string | null;
	version: number;
	/** The diagram printed back, so the caller sees what canonical form its text took. */
	text: string;
}

/** An element as the model has it, and where it shows. */
export interface ElementInfo {
	id: Id;
	kind: string;
	name: string;
	stereotype?: string;
	/** The diagrams with a view of it; empty for an element no view shows. */
	onDiagrams: Id[];
	/** Mentioned in content Aster keeps but cannot show (other StarUML diagram types, tags). */
	inUnknown: boolean;
}
export interface ProjectResult {
	/** The `.aster` document's project (docs/file-format.md), layouts included on request. */
	project: unknown;
	/** Elements that show on no diagram. */
	hidden: ElementInfo[];
	version: number;
}
export interface Point {
	x: number;
	y: number;
}
export interface ShowResult {
	diagramId: Id;
	/** What gained a view: the elements asked for, plus the relationships now drawable. */
	added: Id[];
	label: string | null;
	version: number;
}
export interface DeleteResult {
	deleted: Id[];
	label: string | null;
	version: number;
}

/** One element in full: as the model has it, where it shows, and the lines that touch it. */
export interface ElementDetail {
	element: unknown;
	info: ElementInfo;
	/** Its layout on each diagram that shows it, keyed by diagram id. */
	layouts: Record<Id, unknown>;
	/** The relationships and links whose source or target it is, as model elements. */
	relationships: unknown[];
}
export interface FindParams {
	/** Case-insensitive substring of the name; every element when omitted. */
	query?: string;
	kind?: 'classifier' | 'relationship' | 'package' | 'note' | 'text' | 'instance' | 'link';
	stereotype?: string;
	/** Only elements with a view on this diagram (id or unique name). */
	diagram?: string;
	/** Only elements no diagram shows. */
	hiddenOnly?: boolean;
}
export interface SelectionResult {
	selection: ElementInfo[];
	editing: boolean;
	activeDiagramId: Id;
	version: number;
}
export interface ValidationFinding {
	rule: string;
	elementId: Id;
	element: string;
	memberId?: Id;
	subject: string;
	/** The sentence the Validation panel shows. */
	message: string;
}
export interface ValidateResult {
	findings: ValidationFinding[];
	version: number;
}
export interface RenderParams {
	diagram?: string;
	/** Only these elements (ids or unique names) and the lines between them. */
	only?: string[];
	format?: 'png' | 'svg';
	scale?: 1 | 2;
	background?: 'white' | 'transparent';
}
export interface RenderResult {
	diagramId: Id;
	format: 'png' | 'svg';
	width: number;
	height: number;
	svg?: string;
	/** Base64 PNG bytes. */
	png?: string;
	version: number;
}

/** What a write did: the undo label it made (null when nothing changed) and the new version. */
export interface WriteResult {
	label: string | null;
	version: number;
}
export interface EndParams {
	role?: string | null;
	multiplicity?: string | null;
	navigable?: Navigability;
	visibility?: Visibility | null;
}
export interface AddClassifierParams {
	diagram?: string;
	kind?: ClassifierKind;
	name: string;
	stereotype?: string;
	abstract?: boolean;
	/** Member lines in UML text, as typed in the inline editor: `- balance: Money = 0`. */
	attributes?: string[];
	operations?: string[];
	literals?: string[];
	documentation?: string;
	at?: Point;
	/** An element (id or name) to place the new one to the right of. */
	near?: string;
}
export interface SetMembersParams {
	id: string;
	/** A list given replaces that compartment; a list left out is kept as it is. */
	attributes?: string[];
	operations?: string[];
	literals?: string[];
}
export interface ConnectParams {
	diagram?: string;
	source: string;
	target: string;
	kind: RelationshipKind;
	name?: string;
	stereotype?: string;
	sourceEnd?: EndParams;
	targetEnd?: EndParams;
}
export interface UpdateParams {
	id: string;
	name?: string;
	/** null clears it. */
	stereotype?: string | null;
	abstract?: boolean;
	leaf?: boolean;
	visibility?: Visibility;
	classifierKind?: ClassifierKind;
	relationshipKind?: RelationshipKind;
	/** Swap a relationship's source and target. */
	flip?: boolean;
	sourceEnd?: EndParams;
	targetEnd?: EndParams;
	documentation?: string;
	/** A note's or text's content. */
	text?: string;
}
export interface AddNoteParams {
	diagram?: string;
	text: string;
	/** Elements (ids or names) the note points at. */
	linkTo?: string[];
	at?: Point;
}
export interface MoveToPackageParams {
	ids: string[];
	/** The package (id or name); null for the top of the model. */
	package: string | null;
	/** Make the package when no element has that name. */
	create?: boolean;
	diagram?: string;
	at?: Point;
}
export interface DisplayParams {
	diagram?: string;
	/** The nodes to set; the diagram's defaults when left out. */
	ids?: string[];
	flags: Partial<DisplayFlags>;
}
export interface LayoutParams {
	diagram?: string;
	algorithm?: 'layered' | 'orthogonal';
	direction?: 'DOWN' | 'UP' | 'RIGHT' | 'LEFT';
	/** Two or more elements to lay out among themselves; the whole diagram when left out. */
	only?: string[];
}

export interface Params {
	status: Record<string, never>;
	/** `diagram` is an id or a unique name; the active diagram when omitted. */
	get_text: { diagram?: string; dialect?: Dialect };
	set_text: { diagram?: string; text: string; expectVersion?: number };
	get_project: { layout?: boolean };
	/** Ids or unique names; `at` places by id, else free space is found. */
	add_to_diagram: {
		diagram?: string;
		ids: string[];
		at?: Record<string, Point>;
		/** Also show every model relationship between elements then on the diagram (default true). */
		relationships?: boolean;
	};
	delete: { ids: string[]; from: 'model' | 'diagram'; diagram?: string; expectVersion?: number };
	get_element: { id: string };
	find: FindParams;
	get_selection: Record<string, never>;
	validate: Record<string, never>;
	render: RenderParams;
	add_classifier: AddClassifierParams;
	set_members: SetMembersParams;
	connect: ConnectParams;
	update: UpdateParams;
	add_note: AddNoteParams;
	move_to_package: MoveToPackageParams;
	/** Absolute positions by element id or name, on one diagram. */
	arrange: { diagram?: string; positions: Record<string, Point> };
	display: DisplayParams;
	layout: LayoutParams;
	select: { ids: string[]; centre?: boolean };
	open_diagram: { diagram: string };
	add_diagram: { name: string; kind?: DiagramKind; open?: boolean };
	undo: Record<string, never>;
	redo: Record<string, never>;
	/** Registered commands by id and args (the catalogue `aster://commands`), as one undo step. */
	run: { label: string; commands: SerialisedCommand[] };
}
export interface Results {
	status: Status;
	get_text: TextResult;
	set_text: SetTextResult;
	get_project: ProjectResult;
	add_to_diagram: ShowResult;
	delete: DeleteResult;
	get_element: ElementDetail;
	find: ElementInfo[];
	get_selection: SelectionResult;
	validate: ValidateResult;
	render: RenderResult;
	add_classifier: WriteResult & { id: Id };
	set_members: WriteResult & { id: Id };
	connect: WriteResult & { id: Id };
	update: WriteResult & { id: Id };
	add_note: WriteResult & { id: Id };
	move_to_package: WriteResult & { packageId: Id | null };
	arrange: WriteResult;
	display: WriteResult;
	layout: WriteResult;
	select: { selection: Id[]; version: number };
	open_diagram: { diagramId: Id; version: number };
	add_diagram: WriteResult & { diagramId: Id };
	undo: WriteResult;
	redo: WriteResult;
	run: WriteResult;
}
export type Method = keyof Params;

export interface BridgeRequest<M extends Method = Method> {
	id: string;
	method: M;
	params: Params[M];
}

export type ErrorCode =
	| 'no_tab'
	| 'timeout'
	| 'unknown_method'
	| 'no_editor'
	| 'no_diagram'
	| 'no_element'
	| 'not_on_diagram'
	| 'bad_args'
	| 'ambiguous'
	| 'object_diagram'
	| 'syntax'
	| 'stale'
	| 'failed';

export type BridgeResponse<M extends Method = Method> =
	| { id: string; ok: true; version: number; result: Results[M] }
	| { id: string; ok: false; code: ErrorCode; error: string; version?: number };

/** One connected tab, as the dev server lists them. */
export interface TabInfo extends Hello {
	/** When it last said hello, ISO 8601. */
	at: string;
	/** The tab that answers requests right now. */
	active: boolean;
}

export const EVENTS = {
	hello: 'aster:hello',
	/** The server, to every tab, after a (re)connection: say hello again. */
	who: 'aster:who',
	request: 'aster:req',
	response: 'aster:res',
	changed: 'aster:changed'
} as const;

declare module 'vite/types/customEvent.d.ts' {
	interface CustomEventMap {
		'aster:hello': Hello;
		'aster:who': undefined;
		'aster:req': BridgeRequest;
		'aster:res': BridgeResponse;
		'aster:changed': Changed;
	}
}
