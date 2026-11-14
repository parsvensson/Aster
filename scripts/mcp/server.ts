/**
 * The MCP server (docs/mcp.md): the tools Claude Code sees, each a question to the open tab
 * through the broker. Slice 1: status, the diagram as text, and the diagram from text.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Broker, BrokerError } from './broker.ts';
import { COMMANDS_MD } from './catalogue.ts';

export const SERVER_INFO = { name: 'aster', version: '0.1.0' };

const diagram = z
	.string()
	.optional()
	.describe('A diagram id or unique name from aster_status. Omit for the diagram the tab shows.');
const point = z.object({ x: z.number(), y: z.number() });
const end = z
	.object({
		role: z.string().nullable().optional(),
		multiplicity: z.string().nullable().optional().describe('"1", "0..1", "1..*", "*"'),
		navigable: z.enum(['unspecified', 'navigable', 'notNavigable']).optional(),
		visibility: z.enum(['public', 'protected', 'private', 'package']).nullable().optional()
	})
	.optional();
const relationshipKind = z.enum([
	'association',
	'aggregation',
	'composition',
	'generalization',
	'realization',
	'dependency'
]);
const classifierKind = z.enum(['class', 'interface', 'enum', 'dataType', 'primitiveType']);
const visibility = z.enum(['public', 'protected', 'private', 'package']);
const flags = z
	.object({
		showVisibility: z.boolean().optional(),
		showType: z.boolean().optional(),
		showMultiplicity: z.boolean().optional(),
		showOperationSignature: z.boolean().optional(),
		showNamespace: z.boolean().optional(),
		showProperty: z.boolean().optional(),
		suppressAttributes: z.boolean().optional(),
		suppressOperations: z.boolean().optional(),
		suppressLiterals: z.boolean().optional(),
		stereotypeDisplay: z
			.enum(['none', 'label', 'decoration', 'decoration-label', 'icon', 'icon-label'])
			.optional(),
		wordWrap: z.boolean().optional(),
		autoResize: z.boolean().optional()
	})
	.describe('Display flags, as the Display menu names them.');
const written = (r: { label: string | null; version: number }, more = '') =>
	text(
		r.label
			? `Applied as "${r.label}" (version ${r.version}).${more}`
			: `Nothing changed (version ${r.version}).${more}`
	);

export const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
export const json = (v: unknown) => text(JSON.stringify(v, null, 2));
export const failed = (e: unknown): CallToolResult => ({
	isError: true,
	content: [
		{
			type: 'text',
			text:
				e instanceof BrokerError
					? `${e.code}: ${e.message}`
					: e instanceof Error
						? e.message
						: String(e)
		}
	]
});

export function createMcpServer(broker: Broker, instructions?: string): McpServer {
	const server = new McpServer(SERVER_INFO, instructions ? { instructions } : undefined);

	server.registerTool(
		'aster_status',
		{
			title: 'Aster: what is open',
			description:
				'The project open in the Aster tab: its name and file, the diagrams (id, name, kind, element count), the active diagram, what the user has selected, whether something is being edited inline, the undo and redo labels, element counts, and the model version. Call this first; its version and diagram ids feed the other tools. Fails when no tab is connected.',
			annotations: { readOnlyHint: true }
		},
		async () => {
			try {
				const status = await broker.request('status', {});
				return json({
					...status,
					tabs: broker.infos,
					changes: broker.changesSince(0).length
				});
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_get_text',
		{
			title: 'Aster: diagram as text',
			description:
				"One diagram as PlantUML (the dialect Aster's Text view speaks: classes, interfaces, enums, members as UML text lines, the six relationship kinds with multiplicities and roles, notes) or as Mermaid classDiagram (read-only). Read this before aster_set_text, and edit that text.",
			inputSchema: {
				diagram,
				dialect: z
					.enum(['puml', 'mermaid'])
					.default('puml')
					.describe('puml (default) round-trips through aster_set_text; mermaid is read-only.')
			},
			annotations: { readOnlyHint: true }
		},
		async ({ diagram, dialect }) => {
			try {
				const r = await broker.request('get_text', { diagram, dialect });
				return text(`// ${r.diagram} (${r.diagramId}), version ${r.version}\n${r.text}`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_set_text',
		{
			title: 'Aster: diagram from text',
			description:
				'Makes a diagram match a PlantUML document, as one undo step in the tab ("… via MCP" in its undo menu). Classes the text still names keep their id, position, documentation and anything PlantUML cannot say; new ones are placed in free space; a class the text drops leaves the diagram but stays in the model; one class gone and one new in the same edit is a rename. Start from aster_get_text and change that text. Pass expectVersion from your last read so the write is refused when the user edited in between. Syntax errors change nothing and are reported with line numbers.',
			inputSchema: {
				text: z.string().describe('The whole diagram, @startuml … @enduml.'),
				diagram,
				expectVersion: z
					.number()
					.int()
					.optional()
					.describe('The model version your text was based on; refused when the model moved on.')
			},
			annotations: { destructiveHint: false, idempotentHint: true }
		},
		async ({ text: puml, diagram, expectVersion }) => {
			try {
				const r = await broker.request('set_text', { text: puml, diagram, expectVersion });
				const head = r.changed
					? `Applied as "${r.label}" (version ${r.version}).`
					: `Nothing to change: the diagram already matched (version ${r.version}).`;
				return text(`${head}\n\n${r.text}`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_get_project',
		{
			title: 'Aster: the whole model',
			description:
				"The whole project as Aster's .aster JSON: every element (classifiers with members, relationships with ends, packages, notes, instances) keyed by id, and every diagram with the ids it shows. Also lists `hidden`: elements no diagram shows, each flagged `inUnknown` when content Aster keeps but cannot display (other StarUML diagram types, tags) still refers to it, so deleting it would break that content. Layouts are left out unless `layout` is true.",
			inputSchema: {
				layout: z.boolean().default(false).describe('Include node positions and edge waypoints.')
			},
			annotations: { readOnlyHint: true }
		},
		async ({ layout }) => {
			try {
				return json(await broker.request('get_project', { layout }));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_add_to_diagram',
		{
			title: 'Aster: show existing elements on a diagram',
			description:
				'Gives elements that already exist in the model a view on a diagram, as one undo step: use it for classes that are in the model but not drawn (aster_get_project lists them under hidden). Nodes go where `at` says (model coordinates, pixels; a class is 160 wide) or into free space; every model relationship between elements then on the diagram is drawn too unless `relationships` is false. Nothing is created in the model: to add new classes, use aster_set_text.',
			inputSchema: {
				ids: z.array(z.string()).min(1).describe('Element ids, or unique names.'),
				diagram,
				at: z
					.record(z.string(), z.object({ x: z.number(), y: z.number() }))
					.optional()
					.describe('Positions by id or name, for the nodes you want placed deliberately.'),
				relationships: z.boolean().default(true)
			},
			annotations: { destructiveHint: false }
		},
		async ({ ids, diagram, at, relationships }) => {
			try {
				const r = await broker.request('add_to_diagram', { ids, diagram, at, relationships });
				return text(
					r.label
						? `Applied as "${r.label}" (version ${r.version}): ${r.added.length} views added on ${r.diagramId}: ${r.added.join(', ')}`
						: `Nothing to add: every one of them is on ${r.diagramId} already (version ${r.version}).`
				);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_delete',
		{
			title: 'Aster: delete elements',
			description:
				'Deletes elements, as one undo step the user can take back with ⌘Z. `from: "model"` removes them from the model and every diagram, and takes every relationship that touches them along, as StarUML does. `from: "diagram"` only removes their views from one diagram (the element stays in the model). Check aster_get_project\'s `hidden` list and its `inUnknown` flags before deleting from the model; pass expectVersion from your last read.',
			inputSchema: {
				ids: z.array(z.string()).min(1).describe('Element ids, or unique names.'),
				from: z.enum(['model', 'diagram']),
				diagram,
				expectVersion: z.number().int().optional()
			},
			annotations: { destructiveHint: true }
		},
		async ({ ids, from, diagram, expectVersion }) => {
			try {
				const r = await broker.request('delete', { ids, from, diagram, expectVersion });
				return text(
					r.label
						? `Applied as "${r.label}" (version ${r.version}): ${r.deleted.length} deleted from the ${from}: ${r.deleted.join(', ')}`
						: `Nothing deleted (version ${r.version}).`
				);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_get_element',
		{
			title: 'Aster: one element in full',
			description:
				'One element as the model has it (a classifier with every attribute, operation and literal; a relationship with its ends; a package, note or instance), which diagrams show it and where, and every relationship or link that touches it.',
			inputSchema: { id: z.string().describe('An element id, or a unique name.') },
			annotations: { readOnlyHint: true }
		},
		async ({ id }) => {
			try {
				return json(await broker.request('get_element', { id }));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_find',
		{
			title: 'Aster: find elements',
			description:
				'Elements by name (case-insensitive substring), kind, stereotype, the diagram they are on, or only those no diagram shows. Each comes with its id, kind, name, stereotype, the diagrams that show it and whether unseen content still refers to it. With no filters: every element.',
			inputSchema: {
				query: z.string().optional(),
				kind: z
					.enum(['classifier', 'relationship', 'package', 'note', 'text', 'instance', 'link'])
					.optional(),
				stereotype: z.string().optional(),
				diagram,
				hiddenOnly: z.boolean().optional().describe('Only elements no diagram shows.')
			},
			annotations: { readOnlyHint: true }
		},
		async (p) => {
			try {
				return json(await broker.request('find', p));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_get_selection',
		{
			title: 'Aster: what the user has selected',
			description:
				'The elements selected in the tab right now, and whether one is being edited inline. "This class" or "these" in the user\'s words means this.',
			annotations: { readOnlyHint: true }
		},
		async () => {
			try {
				return json(await broker.request('get_selection', {}));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_validate',
		{
			title: 'Aster: validation findings',
			description:
				"The findings Aster's Validation panel shows (StarUML's UML001 to UML011 rules and ASTER001, a generalization drawn the wrong way round): rule, element, member when it is one, and the sentence shown. Empty when every rule passes.",
			annotations: { readOnlyHint: true }
		},
		async () => {
			try {
				return json(await broker.request('validate', {}));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_render',
		{
			title: 'Aster: see the diagram',
			description:
				'The diagram (or only the named elements and the lines between them) as the Export sheet draws it: a PNG image to look at, or the SVG text. Use it to check a layout or an edit the way the user sees it.',
			inputSchema: {
				diagram,
				only: z.array(z.string()).optional().describe('Element ids or unique names.'),
				format: z.enum(['png', 'svg']).default('png'),
				scale: z.union([z.literal(1), z.literal(2)]).default(1),
				background: z.enum(['white', 'transparent']).default('white')
			},
			annotations: { readOnlyHint: true }
		},
		async (p) => {
			try {
				const r = await broker.request('render', p);
				const head = `${r.diagramId}, ${r.width}×${r.height} px, version ${r.version}`;
				if (r.format === 'svg') return text(`${head}\n${r.svg}`);
				return {
					content: [
						{ type: 'text', text: head },
						{ type: 'image', data: r.png!, mimeType: 'image/png' }
					]
				};
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_changes_since',
		{
			title: 'Aster: what changed',
			description:
				"The commands run in the tab after a model version (the user's own edits included), newest last, each with its undo label and diagram, plus which tab answers now. Call it with the version from your last read to learn whether the user changed something while you were thinking. Answered by the dev server, so it works even when the tab is busy.",
			inputSchema: {
				version: z.number().int().describe('The model version you last saw; 0 for everything kept.')
			},
			annotations: { readOnlyHint: true }
		},
		async ({ version }) => {
			return json({
				changes: broker.changesSince(version),
				tab: broker.infos.find((t) => t.active) ?? null,
				tabs: broker.infos
			});
		}
	);

	// ---- slice 3: writes on the model, one undo step each ----

	server.registerTool(
		'aster_add_classifier',
		{
			title: 'Aster: add a class',
			description:
				'Creates a class, interface, enum, data type or primitive type in the model and draws it on a diagram. Members are UML text lines as typed in Aster ("- balance: Money = 0", "+ pay(amount: Money): Receipt", "{static} count: int", "ACTIVE" for a literal). Placed at `at`, right of `near`, or in free space. Returns the new id.',
			inputSchema: {
				name: z.string(),
				kind: classifierKind.default('class'),
				diagram,
				stereotype: z.string().optional(),
				abstract: z.boolean().optional(),
				attributes: z.array(z.string()).optional(),
				operations: z.array(z.string()).optional(),
				literals: z.array(z.string()).optional().describe('Enum literals.'),
				documentation: z.string().optional(),
				at: point.optional(),
				near: z.string().optional().describe('Place it to the right of this element.')
			}
		},
		async (p) => {
			try {
				const r = await broker.request('add_classifier', p);
				return written(r, ` New element id: ${r.id}`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_set_members',
		{
			title: "Aster: set a classifier's members",
			description:
				"Replaces a classifier's attributes, operations or literals with the lines given (UML text, one per member, in order). A compartment left out is kept. Lines that still match an existing member keep its id and documentation; a line at the same position as an old one counts as an edit of it. Read the classifier first with aster_get_element.",
			inputSchema: {
				id: z.string().describe('The classifier, by id or unique name.'),
				attributes: z.array(z.string()).optional(),
				operations: z.array(z.string()).optional(),
				literals: z.array(z.string()).optional()
			}
		},
		async (p) => {
			try {
				return written(await broker.request('set_members', p));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_connect',
		{
			title: 'Aster: connect two classifiers',
			description:
				'A relationship between two classifiers drawn on a diagram: association, aggregation or composition (the diamond at the target, the whole), generalization (source is the child), realization (source implements target) or dependency. Roles, multiplicities and navigability go on sourceEnd and targetEnd, for the three association kinds only. Returns the new id.',
			inputSchema: {
				source: z.string(),
				target: z.string(),
				kind: relationshipKind,
				diagram,
				name: z.string().optional(),
				stereotype: z.string().optional().describe('For a dependency: "use", "create" …'),
				sourceEnd: end,
				targetEnd: end
			}
		},
		async (p) => {
			try {
				const r = await broker.request('connect', p);
				return written(r, ` New element id: ${r.id}`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_update',
		{
			title: 'Aster: change an element',
			description:
				"One element's properties, as one undo step. A classifier takes name (type references follow), stereotype (null clears), abstract, leaf, visibility, classifierKind, documentation. A relationship takes name, stereotype, relationshipKind, sourceEnd, targetEnd, flip (swap its direction), documentation. A note or text takes text. A package or object takes name and documentation. Fields that do not fit the element are refused.",
			inputSchema: {
				id: z.string(),
				name: z.string().optional(),
				stereotype: z.string().nullable().optional(),
				abstract: z.boolean().optional(),
				leaf: z.boolean().optional(),
				visibility: visibility.optional(),
				classifierKind: classifierKind.optional(),
				relationshipKind: relationshipKind.optional(),
				flip: z.boolean().optional(),
				sourceEnd: end,
				targetEnd: end,
				documentation: z.string().optional(),
				text: z.string().optional()
			}
		},
		async (p) => {
			try {
				return written(await broker.request('update', p));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_add_note',
		{
			title: 'Aster: add a note',
			description:
				'A note on a diagram, optionally linked to elements (dashed lines). For documentation that belongs to an element itself, use aster_update with documentation instead.',
			inputSchema: {
				text: z.string(),
				diagram,
				linkTo: z.array(z.string()).optional(),
				at: point.optional()
			}
		},
		async (p) => {
			try {
				const r = await broker.request('add_note', p);
				return written(r, ` New element id: ${r.id}`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_move_to_package',
		{
			title: 'Aster: put elements in a package',
			description:
				'Moves classifiers (and packages) into a package, or to the top of the model with package null. With create true, a package named that way is made on the diagram when none exists. Membership is model structure; the package frame is drawn on the diagram where the package has a view.',
			inputSchema: {
				ids: z.array(z.string()).min(1),
				package: z.string().nullable(),
				create: z.boolean().optional(),
				diagram,
				at: point.optional().describe('Where a new package frame goes.')
			}
		},
		async (p) => {
			try {
				const r = await broker.request('move_to_package', p);
				return written(r, r.packageId ? ` Package id: ${r.packageId}` : '');
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_arrange',
		{
			title: 'Aster: place nodes',
			description:
				'Puts nodes at absolute positions on a diagram (model pixels; a class is 160 wide and about 40 high plus 20 per member). For a whole-diagram tidy use aster_layout; use this for a deliberate arrangement, then aster_render to check it.',
			inputSchema: {
				positions: z.record(z.string(), point).describe('By element id or unique name.'),
				diagram
			}
		},
		async (p) => {
			try {
				return written(await broker.request('arrange', p));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_display',
		{
			title: 'Aster: display flags',
			description:
				"What the nodes show: visibility, types, multiplicities, operation signatures, namespace, the stereotype's form, and whether a compartment is suppressed. With ids, the overrides of those nodes; without, the diagram's defaults, which every node without an override follows.",
			inputSchema: { flags, ids: z.array(z.string()).optional(), diagram }
		},
		async (p) => {
			try {
				return written(await broker.request('display', p));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_layout',
		{
			title: 'Aster: auto-layout',
			description:
				"Aster's own auto-layout (ELK) of a diagram, or of two or more chosen elements among themselves: layered (polyline edges) or orthogonal, in a direction. Parents land above children. It switches the tab to that diagram and is one undo step. Check the result with aster_render.",
			inputSchema: {
				diagram,
				algorithm: z.enum(['layered', 'orthogonal']).default('layered'),
				direction: z.enum(['DOWN', 'UP', 'RIGHT', 'LEFT']).default('DOWN'),
				only: z.array(z.string()).optional()
			}
		},
		async (p) => {
			try {
				return written(await broker.request('layout', p));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_select',
		{
			title: 'Aster: select in the tab',
			description:
				"Selects elements in the user's tab, and with centre true pans the view to the first (switching diagram when it is drawn elsewhere), to point the user at something. An empty list clears the selection.",
			inputSchema: { ids: z.array(z.string()), centre: z.boolean().optional() }
		},
		async (p) => {
			try {
				const r = await broker.request('select', p);
				return text(`Selected ${r.selection.length}: ${r.selection.join(', ')}`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_open_diagram',
		{
			title: 'Aster: open a diagram tab',
			description: 'Switches the tab to a diagram, by id or unique name.',
			inputSchema: { diagram: z.string() }
		},
		async (p) => {
			try {
				const r = await broker.request('open_diagram', p);
				return text(`Showing ${r.diagramId}.`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_add_diagram',
		{
			title: 'Aster: new diagram',
			description:
				'A new, empty class or object diagram in the project; with open true the tab switches to it. Put existing elements on it with aster_add_to_diagram.',
			inputSchema: {
				name: z.string(),
				kind: z.enum(['class', 'object']).default('class'),
				open: z.boolean().optional()
			}
		},
		async (p) => {
			try {
				const r = await broker.request('add_diagram', p);
				return written(r, ` Diagram id: ${r.diagramId}`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	for (const step of ['undo', 'redo'] as const)
		server.registerTool(
			`aster_${step}`,
			{
				title: `Aster: ${step}`,
				description: `${step === 'undo' ? 'Undoes' : 'Redoes'} one step in the tab's history, the user's own steps included, and returns its label. Prefer aster_undo over deleting what you just made.`,
				annotations: { destructiveHint: step === 'undo' }
			},
			async () => {
				try {
					const r = await broker.request(step, {});
					return text(
						r.label
							? `${step === 'undo' ? 'Undone' : 'Redone'}: ${r.label} (version ${r.version})`
							: `Nothing to ${step}.`
					);
				} catch (e) {
					return failed(e);
				}
			}
		);

	server.registerTool(
		'aster_run',
		{
			title: 'Aster: run model commands',
			description:
				'The escape hatch: runs registered model commands by id, in order, as one undo step with the label given. The catalogue of ids and args is the resource aster://commands (or aster_commands). New elements need ids you make up (22 URL-safe characters). Use the dedicated tools where one fits; this is for what they do not cover (waypoints, colours, z-order, line styles, objects …).',
			inputSchema: {
				label: z.string().describe('For the undo menu, e.g. "colour the Payment classes".'),
				commands: z.array(z.object({ id: z.string(), args: z.unknown() })).min(1)
			}
		},
		async (p) => {
			try {
				return written(await broker.request('run', p));
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_use_tab',
		{
			title: 'Aster: choose the tab that answers',
			description:
				'When several Aster tabs are open, the one that said hello last (connected, clicked into, or opened a project) answers. This picks another by its url, route or project name, as aster_status lists them under tabs, until the user clicks into one again.',
			inputSchema: { tab: z.string().describe('A url, route or project name from aster_status.') }
		},
		async ({ tab }) => {
			try {
				const t = broker.activate(tab);
				return text(`${t.hello.project} at ${t.hello.url} answers now.`);
			} catch (e) {
				return failed(e);
			}
		}
	);

	server.registerTool(
		'aster_commands',
		{
			title: 'Aster: the command catalogue',
			description:
				'Every model command aster_run accepts, with its args. Also the resource aster://commands.',
			annotations: { readOnlyHint: true }
		},
		async () => text(COMMANDS_MD)
	);
	server.registerResource(
		'commands',
		'aster://commands',
		{ title: 'Aster command catalogue', mimeType: 'text/markdown' },
		async () => ({
			contents: [{ uri: 'aster://commands', mimeType: 'text/markdown', text: COMMANDS_MD }]
		})
	);

	return server;
}
