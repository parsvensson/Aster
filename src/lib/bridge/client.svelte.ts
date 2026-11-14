/**
 * The tab's side of the MCP bridge (docs/mcp.md), alive only under `pnpm dev`: answers the dev
 * server's requests from the stores, runs every write through `projectStore.run` (so it is an undo
 * step, autosaved and announced like any other), and tells the server who it is and what changed.
 * Mounted by +layout.svelte behind `import.meta.hot`, which production builds do not have.
 */
import { tick, untrack } from 'svelte';
import type { ViteHotContext } from 'vite/types/hot.d.ts';
import { autoLayout, jumpTo } from '#lib/canvas/actions.ts';
import { canvasApi } from '#lib/canvas/api.ts';
import { canvasRects } from '#lib/canvas/focus.ts';
import { batch } from '#lib/commands/index.ts';
import { blobToDataUrl, embeddedFontCss, svgToPng } from '#lib/export/image.ts';
import { persist } from '#lib/persist/autosave.svelte.ts';
import { files } from '#lib/persist/files.svelte.ts';
import { projectStore } from '#lib/stores/project.svelte.ts';
import { selection } from '#lib/stores/selection.svelte.ts';
import { drawnRects, handle, modelRects, type Context } from './handle.ts';
import { EVENTS, type BridgeRequest, type Changed, type Hello } from './protocol.ts';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** The editor lives under `/design/<slug>`; the welcome and the projects page have no diagram. */
const inEditor = () => location.pathname.startsWith('/design/');

const context: Context = {
	get project() {
		return projectStore.project;
	},
	get version() {
		return projectStore.version;
	},
	get activeDiagramId() {
		return projectStore.activeDiagramId;
	},
	rects: (d) => {
		const model = modelRects(projectStore.project, d);
		return d.id === projectStore.activeDiagramId ? drawnRects(canvasRects.get(), model) : model;
	},
	run: (plan) => projectStore.run(batch, plan),
	toPng: async (svg, width, height, scale) => {
		const url = await blobToDataUrl(await svgToPng(svg, width, height, scale));
		return url.slice(url.indexOf(',') + 1);
	},
	fontCss: embeddedFontCss,
	select: (ids, centre) => {
		selection.set(ids);
		const [first] = ids;
		if (!centre || !first) return;
		if (projectStore.diagram.elementIds.includes(first)) canvasApi.centreOn(first);
		else jumpTo(first);
	},
	openDiagram: (id) => {
		projectStore.activeDiagramId = id;
	},
	undo: () => projectStore.undo(),
	redo: () => projectStore.redo(),
	layout: async (diagramId, algorithm, direction, only) => {
		// ELK reads the drawn rectangles, so the diagram must be the open one and painted.
		if (projectStore.activeDiagramId !== diagramId) {
			projectStore.activeDiagramId = diagramId;
			await tick();
			await frame();
			await frame();
		}
		selection.set(only ?? []);
		await autoLayout(algorithm, direction);
		return projectStore.undoLabel;
	},
	ui: () => ({
		file: files.current ? { name: files.current.name, format: files.current.format } : null,
		state: files.state,
		editor: inEditor(),
		route: persist.route,
		url: location.href,
		selection: selection.list,
		editing: selection.editing !== null,
		undoLabel: projectStore.undoLabel,
		redoLabel: projectStore.redoLabel
	})
};

/** Starts answering; returns the function that stops. */
export function startBridge(hot: ViteHotContext): () => void {
	const onRequest = (req: BridgeRequest) => {
		// Not inside anyone's effect: a request reads the stores once and answers.
		void untrack(() => handle(req, context)).then((res) => hot.send(EVENTS.response, res));
	};
	const hello = () => {
		const d = projectStore.diagram;
		const payload: Hello = {
			projectId: projectStore.project.id,
			project: projectStore.project.name,
			diagramId: d.id,
			diagram: d.name,
			route: inEditor() ? persist.route : null,
			url: location.href,
			version: projectStore.version
		};
		hot.send(EVENTS.hello, payload);
	};
	const onFocus = () => untrack(hello);

	const onVisible = () => {
		if (document.visibilityState === 'visible') onFocus();
	};

	hot.on(EVENTS.request, onRequest);
	// The socket came back after a dev server restart, or the server asks who is there (it just
	// started, and we loaded before it): say hello again. So does a tab brought to the front.
	hot.on('vite:ws:connect', onFocus);
	hot.on(EVENTS.who, onFocus);
	window.addEventListener('focus', onFocus);
	document.addEventListener('visibilitychange', onVisible);

	const stop = $effect.root(() => {
		// Every command (and undo, redo, load) bumps the version: tell the server what it was.
		$effect(() => {
			const changed: Changed = {
				version: projectStore.version,
				label: projectStore.undoLabel,
				diagramId: projectStore.activeDiagramId
			};
			untrack(() => hot.send(EVENTS.changed, changed));
		});
		// A project opened or a diagram tab switched: who we are has changed.
		$effect(() => {
			void projectStore.opened;
			void projectStore.activeDiagramId;
			untrack(hello);
		});
	});

	return () => {
		stop();
		hot.off(EVENTS.request, onRequest);
		hot.off('vite:ws:connect', onFocus);
		hot.off(EVENTS.who, onFocus);
		window.removeEventListener('focus', onFocus);
		document.removeEventListener('visibilitychange', onVisible);
	};
}
