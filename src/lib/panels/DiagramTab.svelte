<script lang="ts">
	import { renameDiagram, setDiagramDefaults, setDiagramKind } from '#lib/commands/index.ts';
	import { t } from '#lib/i18n/index.ts';
	import type { DiagramKind, DisplayFlags } from '#lib/model/types.ts';
	import { projectStore } from '#lib/stores/project.svelte.ts';
	import Field from '#lib/ui/atoms/Field.svelte';
	import SectionHeading from '#lib/ui/atoms/SectionHeading.svelte';
	import FieldSelect from '#lib/ui/atoms/Select.svelte';
	import DisplayFlagsForm from './DisplayFlagsForm.svelte';

	// Board 15: the diagram's name and its display defaults, nothing else. Per-classifier
	// overrides live in the Properties tab's Display section; the keys still act on the selection
	// when there is one (commands.svelte.ts).
	const diagram = $derived(projectStore.diagram);
	const value = (key: keyof DisplayFlags) => {
		void projectStore.version;
		return diagram.defaults[key];
	};
	const set = (key: keyof DisplayFlags, v: DisplayFlags[keyof DisplayFlags]) =>
		projectStore.run(setDiagramDefaults, { diagramId: diagram.id, patch: { [key]: v } });
	// A class diagram and a concept graph are the same model drawn two ways (owner's request,
	// 2026-11-15); switching also resets the display defaults to the notation's own. An object
	// diagram holds objects and has no second notation.
	const kindItems = $derived(
		(['class', 'concept'] as const).map((k) => ({ value: k, label: t(`diagramKind.${k}`) }))
	);
	// The diagram object is mutated in place; the version says when its kind changed.
	const kind = $derived.by(() => {
		void projectStore.version;
		return diagram.diagramKind;
	});
</script>

<SectionHeading first>{t('diagram.heading')}</SectionHeading>
<label for="diag-name" class="mb-1 block text-chrome-muted">{t('diagram.name')}</label>
<Field
	id="diag-name"
	class="h-9 w-full text-(length:--text-field)"
	value={diagram.name}
	onchange={(e: Event) => {
		const input = e.currentTarget as HTMLInputElement;
		const name = input.value.trim();
		// A blank name is not a rename: the field goes back to the diagram's name.
		if (!name) input.value = diagram.name;
		else if (name !== diagram.name)
			projectStore.run(renameDiagram, { diagramId: diagram.id, name });
	}}
/>

{#if kind !== 'object'}
	<label for="diag-kind" class="mt-3 mb-1 block text-chrome-muted">{t('diagram.shownAs')}</label>
	<FieldSelect
		id="diag-kind"
		class="w-full"
		value={kind}
		items={kindItems}
		onchange={(v) =>
			v !== kind &&
			projectStore.run(setDiagramKind, { diagramId: diagram.id, diagramKind: v as DiagramKind })}
	/>
{/if}

<div class="mt-6">
	<DisplayFlagsForm idPrefix="diag" {value} {set} />
</div>
