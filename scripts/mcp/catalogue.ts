/**
 * The command catalogue for `aster_run` (docs/mcp.md): every command `src/lib/commands` registers,
 * with its args. Hand-written from the `define` calls; `tests/unit/bridge-server.test.ts` checks
 * that every id named here is registered and that no registered id is missing.
 */
export const COMMANDS_MD = `# Aster commands

Each is \`{ "id": "<name>", "args": { … } }\`. Element shapes (Classifier, Attribute, Relationship,
Note, Package, Layout …) are those of the .aster JSON that aster_get_project returns. Ids of new
elements are chosen by the caller: 22 URL-safe base64 characters, like nanoid(22). A batch is one
undo step; the inverse of each command is computed when it runs.

## Elements

| id | args |
| --- | --- |
| addClassifier | { diagramId, classifier: Classifier, at: { x, y } } |
| renameClassifier | { id, name } — rewrites parsed type references too |
| setClassifierFlags | { id, flags: { isAbstract?, isLeaf?, visibility?, stereotype?: string \\| null } } |
| setClassifierKind | { id, classifierKind: 'class' \\| 'interface' \\| 'enum' \\| 'dataType' \\| 'primitiveType' } |
| setDocumentation | { id, documentation } |
| deleteFromModel | { ids } — attached relationships go too |
| restoreElements | the inverse of deleteFromModel; not for direct use |
| replaceElement | { element } — swaps an element for a new version with the same id |

## Members (kind: 'attribute' | 'operation' | 'literal'; text is a UML line like "- balance: Money = 0")

| id | args |
| --- | --- |
| addMember | { classifierId, kind, member, index? } |
| deleteMember | { classifierId, kind, memberId } |
| replaceMember | { classifierId, kind, member } |
| setMemberText | { classifierId, kind, memberId, text } |
| reorderMember | { classifierId, kind, memberId, to } |
| setLiterals | { id, literals: Literal[] } |

## Relationships

| id | args |
| --- | --- |
| connect | { diagramId, id, sourceId, targetId, kind } — for aggregation/composition the diamond is at the target |
| setRelationshipKind | { id, relationshipKind } |
| setRelationshipName | { id, name: string \\| null } |
| setRelationshipStereotype | { id, stereotype: string \\| null } |
| setEnd | { id, end: 'source' \\| 'target', patch: { role?, multiplicity?, visibility?, navigable?, isDerived?, ownsOther? } } (null clears) |
| flipRelationship | { id } |

## Views (one diagram)

| id | args |
| --- | --- |
| addToDiagram | { diagramId, entries: [{ id, layout: NodeLayout \\| EdgeLayout, index? }] } |
| deleteFromDiagram | { diagramId, ids } |
| moveNode | { diagramId, ids, dx, dy } |
| setNodePositions | { diagramId, positions: [{ id, x, y }] } |
| resizeNode | { diagramId, id, w, h } |
| restack | { diagramId, ids, place: 'front' \\| 'back' } |
| setViewOrder | { diagramId, order: Id[] } |
| setNodeFlags | { diagramId, id, patch: Partial<DisplayFlags> } — an undefined value removes the override |
| setDiagramDefaults | { diagramId, patch: Partial<DisplayFlags> } |
| setColour | { diagramId, id, key: 'fill' \\| 'line', colour: '#rrggbb' \\| null } |
| setLineStyle | { diagramId, id, lineStyle: 'rectilinear' \\| 'oblique' \\| 'roundrect' \\| 'curve' } |
| addWaypoint | { diagramId, id, index, point } |
| moveWaypoint | { diagramId, id, index, point } |
| removeWaypoint | { diagramId, id, index } |
| setWaypoints | { diagramId, id, waypoints: Point[] } |
| setLabelOffset | { diagramId, id, key: LabelKey, offset: { alpha, distance } \\| null } |

## Diagrams and project

| id | args |
| --- | --- |
| addDiagram | { diagramId, name, index?, diagramKind?: 'class' \\| 'object' } |
| renameDiagram | { diagramId, name } |
| deleteDiagram | { diagramId } |
| removeDiagram, restoreDiagram | inverses; not for direct use |
| renameProject | { name } |

## Notes, text, packages, objects

| id | args |
| --- | --- |
| addNote | { diagramId, note: { kind: 'note', id, text, linkedIds: [] }, at } |
| addText | { diagramId, text: { kind: 'text', id, text }, at } |
| setElementText | { id, text } |
| linkNote / unlinkNote | { noteId, targetId } |
| addPackage | { diagramId, pkg: { kind: 'package', id, name, memberIds: [], documentation }, at } |
| moveToPackage | { moves: [{ id, to: Id \\| null }] } |
| addInstance | { diagramId, instance: Instance, at } |
| addLink | { diagramId, id, sourceId, targetId } |
| importFragment / removeFragment | a StarUML fragment file's contents; see src/lib/mdj/fragment.ts |

## Grouping

| id | args |
| --- | --- |
| batch | { label, commands: [{ id, args }] } — what aster_run itself sends |
`;

/** The ids the catalogue names, for the test that keeps it in step with the registry. */
export const CATALOGUE_IDS = [
	...COMMANDS_MD.matchAll(/^\| ([A-Za-z]+(?:(?:, | \/ )[A-Za-z]+)*) \|/gm)
]
	.flatMap((m) => m[1].split(/, | \/ /))
	.filter((id) => id !== 'id');
