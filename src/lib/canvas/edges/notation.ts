/** UML 2.5 notation rules for an edge: which markers, which dash, which labels. */
import type {
	DiagramKind,
	DisplayFlags,
	End,
	LabelKey,
	LabelOffset,
	Link,
	Navigability,
	Relationship,
	Visibility
} from '#lib/model/types.ts';

export type MarkerId = 'triangle' | 'arrow' | 'diamond-hollow' | 'diamond-filled';
export interface Notation {
	/** Marker at the source end (path start) and at the target end (path end). */
	start: MarkerId | null;
	end: MarkerId | null;
	dashed: boolean;
	/** Ends that touch the classifier typing an owned end: the ownership dot goes there. */
	dots: ('source' | 'target')[];
}

/** Marker lengths along the line, in paper units (ui.md). */
export const MARKER_LENGTH: Record<MarkerId, number> = {
	triangle: 14,
	arrow: 12,
	'diamond-hollow': 14,
	'diamond-filled': 14
};

/**
 * A link between objects draws as the plain line of an association with no ends (UML 2.5): the
 * relationship edge and the exporter are given this stand-in. Commands go to the link itself.
 */
export const linkAsRelationship = (l: Link): Relationship => ({
	kind: 'relationship',
	id: l.id,
	relationshipKind: 'association',
	sourceId: l.sourceId,
	targetId: l.targetId,
	documentation: l.documentation,
	...(l.name !== undefined && { name: l.name })
});

const navigable = (e: End | undefined) => e?.navigable === 'navigable';

export function markersFor(r: Relationship): Notation {
	switch (r.relationshipKind) {
		case 'generalization':
			return { start: null, end: 'triangle', dashed: false, dots: [] };
		case 'realization':
			return { start: null, end: 'triangle', dashed: true, dots: [] };
		case 'dependency':
			return { start: null, end: 'arrow', dashed: true, dots: [] };
	}
	// Association family: an arrow at a navigable end only when the other end is not navigable.
	const s = r.sourceEnd;
	const t = r.targetEnd;
	const arrowAtSource = navigable(s) && !navigable(t);
	const arrowAtTarget = navigable(t) && !navigable(s);
	const diamond =
		r.relationshipKind === 'aggregation'
			? 'diamond-hollow'
			: r.relationshipKind === 'composition'
				? 'diamond-filled'
				: null;
	const dots: Notation['dots'] = [];
	if (s?.ownsOther) dots.push('target');
	if (t?.ownsOther) dots.push('source');
	return {
		start: arrowAtSource ? 'arrow' : null,
		end: diamond ?? (arrowAtTarget ? 'arrow' : null),
		dashed: false,
		dots
	};
}

export interface EdgeLabelSpec {
	key: LabelKey;
	at: 'source' | 'target' | 'mid';
	lines: string[];
	/** Where the label sits until the user moves it, when not the key's usual place (geometry.ts). */
	offset?: LabelOffset;
}

const SYMBOL: Record<Visibility, string> = {
	public: '+',
	protected: '#',
	private: '-',
	package: '~'
};

/** Name (with «stereotype» above it) at the middle; role and multiplicity at each association end. */
export function labelsFor(r: Relationship, flags: DisplayFlags): EdgeLabelSpec[] {
	const out: EdgeLabelSpec[] = [];
	const mid = [...(r.stereotype ? [`«${r.stereotype}»`] : []), ...(r.name ? [r.name] : [])];
	if (mid.length) out.push({ key: 'name', at: 'mid', lines: mid });
	for (const [at, e] of [
		['source', r.sourceEnd],
		['target', r.targetEnd]
	] as const) {
		if (!e) continue;
		if (e.role) {
			const vis = flags.showVisibility && e.visibility ? SYMBOL[e.visibility] : '';
			out.push({ key: `${at}Role`, at, lines: [`${vis}${e.isDerived ? '/' : ''}${e.role}`] });
		}
		if (flags.showMultiplicity && e.multiplicity)
			out.push({ key: `${at}Multiplicity`, at, lines: [e.multiplicity] });
		const props = [...(e.isOrdered ? ['ordered'] : []), ...(e.isUnique ? ['unique'] : [])];
		if (flags.showProperty && props.length)
			out.push({ key: `${at}Property`, at, lines: [`{${props.join(', ')}}`] });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Concept graphs (owner's request, 2026-11-15): the same relationships, read as sentences.
// ---------------------------------------------------------------------------

const ASSOCIATION_FAMILY = new Set(['association', 'aggregation', 'composition']);

export interface ConceptDirections {
	/** Read from the source to the target: the source end's role is the verb. */
	forward: boolean;
	/** Read from the target to the source: the target end's role is the verb. */
	backward: boolean;
}

/**
 * Which way a concept graph reads a relationship. UML navigability decides: an end marked not
 * navigable closes the reading towards it, and an end marked navigable opens it. With nothing
 * said at either end (StarUML's default) and a verb on one end only, the line reads that way
 * alone, so a file whose author named one role per line draws one arrow per line unasked.
 */
export function conceptDirections(r: Relationship): ConceptDirections {
	const s = r.sourceEnd;
	const t = r.targetEnd;
	const unspecified = (e: End | undefined) => !e || e.navigable === 'unspecified';
	const forwardVerb = !!s?.role;
	const backwardVerb = !!t?.role;
	// Nothing said about navigability: one verb reads one way, otherwise the line reads both ways.
	if (unspecified(s) && unspecified(t) && forwardVerb !== backwardVerb)
		return { forward: forwardVerb, backward: backwardVerb };
	return { forward: t?.navigable !== 'notNavigable', backward: s?.navigable !== 'notNavigable' };
}

export type ConceptDirection = 'both' | 'forward' | 'backward';

/** The inspector's one-word reading of the directions, or null when the line reads neither way. */
export function conceptDirection(r: Relationship): ConceptDirection | null {
	const d = conceptDirections(r);
	if (d.forward && d.backward) return 'both';
	if (d.forward) return 'forward';
	if (d.backward) return 'backward';
	return null;
}

/** The navigability of each end that makes a line read a chosen way, explicit so the verb rule stays out. */
export function navigabilityFor(direction: ConceptDirection): {
	source: Navigability;
	target: Navigability;
} {
	switch (direction) {
		case 'both':
			return { source: 'navigable', target: 'navigable' };
		case 'forward':
			return { source: 'notNavigable', target: 'navigable' };
		case 'backward':
			return { source: 'navigable', target: 'notNavigable' };
	}
}

/**
 * A concept graph's markers: an arrowhead at each end the line reads towards, no diamonds and no
 * ownership dots (the verb says "is part of"). Generalization, realization and dependency keep
 * their UML form.
 */
export function conceptMarkersFor(r: Relationship): Notation {
	if (!ASSOCIATION_FAMILY.has(r.relationshipKind)) return markersFor(r);
	const dir = conceptDirections(r);
	return {
		start: dir.backward ? 'arrow' : null,
		end: dir.forward ? 'arrow' : null,
		dashed: false,
		dots: []
	};
}

/** The verbs sit beside the middle of the line: the forward one on one side, the backward one on the other. */
export const CONCEPT_OFFSETS: Record<'sourceRole' | 'targetRole', LabelOffset> = {
	sourceRole: { alpha: Math.PI / 2, distance: 14 },
	targetRole: { alpha: -Math.PI / 2, distance: 14 }
};

/**
 * A concept graph's labels: the name (with «stereotype») at the middle as in UML, the verb of
 * each direction the line reads, and multiplicities at the ends only when shown. A line that
 * reads neither way (both ends not navigable) still carries both verbs, so nothing is lost.
 */
export function conceptLabelsFor(r: Relationship, flags: DisplayFlags): EdgeLabelSpec[] {
	if (!ASSOCIATION_FAMILY.has(r.relationshipKind)) return labelsFor(r, flags);
	const out: EdgeLabelSpec[] = [];
	const mid = [...(r.stereotype ? [`«${r.stereotype}»`] : []), ...(r.name ? [r.name] : [])];
	if (mid.length) out.push({ key: 'name', at: 'mid', lines: mid });
	const dir = conceptDirections(r);
	const neither = !dir.forward && !dir.backward;
	if (r.sourceEnd?.role && (dir.forward || neither))
		out.push({
			key: 'sourceRole',
			at: 'mid',
			lines: [r.sourceEnd.role],
			offset: CONCEPT_OFFSETS.sourceRole
		});
	if (r.targetEnd?.role && (dir.backward || neither))
		out.push({
			key: 'targetRole',
			at: 'mid',
			lines: [r.targetEnd.role],
			offset: CONCEPT_OFFSETS.targetRole
		});
	if (flags.showMultiplicity)
		for (const [at, e] of [
			['source', r.sourceEnd],
			['target', r.targetEnd]
		] as const)
			if (e?.multiplicity) out.push({ key: `${at}Multiplicity`, at, lines: [e.multiplicity] });
	return out;
}

/** The notation a diagram kind draws its edges with. */
export function edgeNotation(kind: DiagramKind) {
	return kind === 'concept'
		? { markers: conceptMarkersFor, labels: conceptLabelsFor }
		: { markers: markersFor, labels: labelsFor };
}
