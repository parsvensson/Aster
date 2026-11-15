<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { t } from '#lib/i18n/index.ts';
	import { flow, type ClassifierFlowNode } from '#lib/stores/flow.svelte.ts';
	import { projectStore } from '#lib/stores/project.svelte.ts';
	import LineEditor from './LineEditor.svelte';
	import ResizeCorner from './ResizeCorner.svelte';
	import { edit } from './inline.ts';
	import { CONCEPT_MIN, type Size } from './resize.ts';
	import { elementSummary } from './summary.ts';

	/**
	 * A concept on a concept graph (owner's request, 2026-11-15): the same classifier as on a class
	 * diagram, drawn as a rounded box with its name alone, wrapped to the box's width. Members,
	 * stereotype and namespace stay in the model and in the inspector; the lines carry the verbs
	 * (edges/notation.ts). Focus, selection, handles, resizing and the name editor are the class
	 * node's, so every keyboard path of accessibility.md holds here too.
	 */
	let { id, data, selected }: NodeProps<ClassifierFlowNode> = $props();

	const HANDLES = [
		{ id: 't', position: Position.Top },
		{ id: 'r', position: Position.Right },
		{ id: 'b', position: Position.Bottom },
		{ id: 'l', position: Position.Left }
	];

	const c = $derived(data.classifier);
	const summary = $derived(
		elementSummary(projectStore.project, projectStore.diagram, id, { index: flow.relIndex })
	);
	let root: HTMLDivElement;
	let live = $state<Size | null>(null);
	const width = $derived(live?.w ?? data.minWidth);
	const minHeight = $derived(live?.h ?? Math.max(CONCEPT_MIN.h, data.minHeight));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={root}
	class="concept-node uml-paint"
	role="group"
	aria-label={summary}
	tabindex={data.focus === 'self' ? 0 : -1}
	data-focus-id={id}
	data-part="self"
	class:selected
	class:link-target={data.link === 'target' || data.link === 'both'}
	class:edge-hover={data.hovered}
	style:width="{width}px"
	style:min-height="{minHeight}px"
	style:--fill={data.fill}
	style:--line={data.line}
	data-name={c.name}
	data-kind="concept"
>
	<!-- Double-click is a pointer shortcut only; F2 / ↩ on the selected node is the keyboard path. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="name-row"
		ondblclick={(e) => {
			e.stopPropagation();
			edit(id, { part: 'name' });
		}}
	>
		{#if data.editing?.part === 'name'}
			<LineEditor
				{id}
				target={{ part: 'name' }}
				initial={c.name}
				label={t('ui.className')}
				selectAll
			/>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<span
				class="name"
				class:abstract={c.isAbstract}
				tabindex={data.focus === 'name' ? 0 : -1}
				data-focus-id={id}
				data-part="name">{c.name}</span
			>
		{/if}
	</div>
	{#each HANDLES as h (h.id)}
		<Handle type="source" id={h.id} position={h.position} class="uml-handle" />
	{/each}
	{#if selected}
		<span class="handle tl"></span><span class="handle tr"></span>
		<span class="handle bl"></span>
	{/if}
	<ResizeCorner
		{id}
		shown={selected}
		from={() => ({ w: root.offsetWidth, h: root.offsetHeight })}
		min={CONCEPT_MIN}
		onlive={(s) => (live = s)}
	/>
</div>

<style>
	/* The class node's paper and strokes (ui.md), rounded; the width is the stored one and the
	   name wraps inside it, so a box is sized by hand and never grows sideways. */
	.concept-node {
		position: relative;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 120px;
		min-height: 48px;
		background: var(--fill, var(--paper-fill));
		color: var(--paper-ink);
		border: var(--uml-stroke) solid var(--line, var(--paper-ink));
		border-radius: 12px;
		font-family: var(--font-paper);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
		cursor: grab;
	}
	.concept-node:hover:not(.selected),
	.concept-node.edge-hover:not(.selected) {
		outline: 1px solid color-mix(in srgb, var(--paper-accent) 50%, transparent);
		outline-offset: 0;
	}
	.concept-node.selected {
		outline: 2px solid var(--paper-accent);
	}
	.concept-node:focus-visible {
		outline: 2px solid var(--paper-accent);
	}
	.concept-node:not(.selected):focus-visible {
		outline: none;
	}
	/* Keyboard focus: the dashed accent ring at 5 px offset (ui.md), following the corners. */
	.concept-node:focus-visible::after {
		content: '';
		position: absolute;
		inset: -7px;
		border: 2px dashed var(--paper-accent);
		border-radius: 18px;
		pointer-events: none;
	}
	.name:focus-visible {
		outline: 2px dashed var(--paper-accent);
		outline-offset: 1px;
	}
	.concept-node.link-target {
		outline: 2px dashed var(--paper-accent);
		outline-offset: 5px;
	}
	.concept-node :global(.uml-handle) {
		width: 24px;
		height: 24px;
		min-width: 0;
		min-height: 0;
		background: transparent;
		border: none;
		border-radius: 50%;
		opacity: 0;
	}
	.concept-node :global(.uml-handle::after) {
		content: '';
		position: absolute;
		inset: 7px;
		box-sizing: border-box;
		border: 2px solid var(--paper-accent);
		border-radius: 50%;
		background: var(--paper-bg);
	}
	.concept-node:hover :global(.uml-handle) {
		opacity: 1;
	}
	.concept-node :global(.uml-handle.svelte-flow__handle-top) {
		transform: translate(-50%, -100%);
	}
	.concept-node :global(.uml-handle.svelte-flow__handle-bottom) {
		transform: translate(-50%, 100%);
	}
	.concept-node :global(.uml-handle.svelte-flow__handle-left) {
		transform: translate(-100%, -50%);
	}
	.concept-node :global(.uml-handle.svelte-flow__handle-right) {
		transform: translate(100%, -50%);
	}
	.name-row {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-height: 46px;
		padding: 10px 12px;
		box-sizing: border-box;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.name.abstract {
		font-style: italic;
	}
	.name-row :global(.line-input) {
		height: 22px;
		padding: 0 4px;
		text-align: center;
		background: color-mix(in srgb, var(--paper-accent) 8%, transparent);
	}
	.handle {
		position: absolute;
		box-sizing: border-box;
		width: 6px;
		height: 6px;
		background: var(--paper-bg);
		border: 1.5px solid var(--paper-accent);
	}
	.handle.tl {
		top: -3px;
		left: -3px;
	}
	.handle.tr {
		top: -3px;
		right: -3px;
	}
	.handle.bl {
		bottom: -3px;
		left: -3px;
	}
</style>
