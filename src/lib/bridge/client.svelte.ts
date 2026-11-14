/**
 * The tab's side of the MCP bridge (docs/mcp.md, docs/plugin.md): answers the server's requests
 * from the stores, runs every write through `projectStore.run` (so it is an undo step, autosaved
 * and announced like any other), and tells the server who it is and what changed. A file the
 * server opened here (`open_file`) is sent back as text after every change, for the server to
 * write. Mounted by +layout.svelte: over Vite's HMR socket under `pnpm dev`, over HTTP when the
 * Claude plugin's server serves the built app; never on the public site.
 */
import { tick, untrack } from 'svelte';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import { autoLayout, jumpTo } from '#lib/canvas/actions.ts';
import { canvasApi } from '#lib/canvas/api.ts';
import { canvasRects } from '#lib/canvas/focus.ts';
import { batch } from '#lib/commands/index.ts';
import { blobToDataUrl, embeddedFontCss, svgToPng } from '#lib/export/image.ts';
import { persist } from '#lib/persist/autosave.svelte.ts';
import {
	files,
	fileText,
	markWritten,
	newProjectFor,
	openFile
} from '#lib/persist/files.svelte.ts';
import { projectStore } from '#lib/stores/project.svelte.ts';
import { selection } from '#lib/stores/selection.svelte.ts';
import { BridgeError, drawnRects, handle, modelRects, type Context } from './handle.ts';
import {
	EVENTS,
	type BridgeRequest,
	type Changed,
	type Channel,
	type Hello,
	type OpenFileParams,
	type OpenFileResult,
	type Save,
	type Saved
} from './protocol.ts';

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

export const SAVE_DEBOUNCE_MS = 300;

/**
 * The file the server keeps on disk for this tab: its name there, the model version the disk
 * holds, and the count of project loads when it was opened (another load means another project).
 */
const sync: { path: string | null; version: number; opened: number } = $state({
	path: null,
	version: -1,
	opened: -1
});

async function openFromServer(p: OpenFileParams): Promise<OpenFileResult> {
	if (!/\.(mdj|aster|aster\.json)$/i.test(p.name))
		throw new BridgeError('bad_args', `${p.name}: only .mdj, .aster and .aster.json files open.`);
	const created = p.text === null;
	if (p.text === null) newProjectFor(p.name, p.diagram);
	else {
		const before = projectStore.opened;
		// Parsed fresh, never restored from this browser's autosave: the file on disk is the truth.
		await openFile(
			{ name: p.name, data: new TextEncoder().encode(p.text).buffer as ArrayBuffer },
			true
		);
		const n = files.notice;
		if (n?.kind === 'failed') throw new BridgeError('failed', `${p.name}: ${n.message}`);
		if (projectStore.opened === before) throw new BridgeError('failed', `${p.name} did not open.`);
	}
	const project = projectStore.project;
	let diagramFound = true;
	if (p.diagram && !created) {
		const q = p.diagram.trim().toLowerCase();
		const hit =
			project.diagrams.find((d) => d.id === p.diagram || d.name === p.diagram) ??
			project.diagrams.find((d) => d.name.trim().toLowerCase() === q);
		if (hit) projectStore.activeDiagramId = hit.id;
		else diagramFound = false;
	}
	sync.path = p.path;
	sync.version = created ? -1 : projectStore.version;
	sync.opened = projectStore.opened;
	const address = resolve('/design/[slug]', { slug: persist.route ?? 'new' });
	if (!inEditor()) await goto(address);
	const d = projectStore.diagram;
	return {
		project: project.name,
		created,
		diagramId: d.id,
		diagram: d.name,
		diagramFound,
		diagrams: project.diagrams.map((x) => ({
			id: x.id,
			name: x.name,
			diagramKind: x.diagramKind,
			elements: x.elementIds.length
		})),
		route: persist.route,
		// The editor moves its address to the new project a moment later; this is where it lands.
		url: new URL(address, location.href).href,
		version: projectStore.version
	};
}
context.openFile = openFromServer;

/** Starts answering; returns the function that stops. */
export function startBridge(channel: Channel): () => void {
	const hot = channel;
	const onRequest = (req: BridgeRequest) => {
		// Not inside anyone's effect: a request reads the stores once and answers.
		void untrack(() => handle(req, context)).then((res) => hot.send(EVENTS.response, res));
	};
	// An editor page that is still restoring its project from this browser would answer for the
	// wrong one, and a file opened meanwhile would be replaced: it says hello once it has booted.
	const booted = () => !inEditor() || persist.ready;
	const hello = () => {
		if (!booted()) return;
		const d = projectStore.diagram;
		const payload: Hello = {
			projectId: projectStore.project.id,
			project: projectStore.project.name,
			diagramId: d.id,
			diagram: d.name,
			route: inEditor() ? persist.route : null,
			url: location.href,
			version: projectStore.version,
			file: sync.path
		};
		hot.send(EVENTS.hello, payload);
	};

	// The file on the server's disk follows the model: its text, a moment after each change.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const sent: Record<number, string> = {};
	const save = () => {
		const path = sync.path;
		const format = files.current?.format;
		if (!path || !format || projectStore.version === sync.version) return;
		const payload: Save = { path, text: fileText(format), version: projectStore.version };
		sent[payload.version] = payload.text;
		hot.send(EVENTS.save, payload);
	};
	const onSaved = (s: Saved) => {
		const text = sent[s.version];
		delete sent[s.version];
		if (s.path !== sync.path || text === undefined) return;
		if (!s.ok) {
			console.warn(`[aster] ${s.path} was not written: ${s.error ?? 'unknown error'}`);
			return;
		}
		sync.version = s.version;
		void markWritten(text, s.version);
	};
	const onFocus = () => untrack(hello);

	const onVisible = () => {
		if (document.visibilityState === 'visible') onFocus();
	};

	hot.on(EVENTS.request, onRequest);
	hot.on(EVENTS.saved, onSaved);
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
		// A project opened or a diagram tab switched: who we are has changed. A project the server
		// did not open here is not the server's file any more.
		$effect(() => {
			const opened = projectStore.opened;
			void projectStore.activeDiagramId;
			// Booted, or sent back to the welcome page (an address this browser has no project for).
			void persist.ready;
			void page.url.pathname;
			untrack(() => {
				if (sync.path && opened !== sync.opened) sync.path = null;
				hello();
			});
		});
		$effect(() => {
			const version = projectStore.version;
			if (!sync.path || version === sync.version) return;
			clearTimeout(timer);
			timer = setTimeout(() => untrack(save), SAVE_DEBOUNCE_MS);
		});
	});

	return () => {
		stop();
		clearTimeout(timer);
		hot.off(EVENTS.saved, onSaved);
		hot.off(EVENTS.request, onRequest);
		hot.off('vite:ws:connect', onFocus);
		hot.off(EVENTS.who, onFocus);
		window.removeEventListener('focus', onFocus);
		document.removeEventListener('visibilitychange', onVisible);
	};
}
