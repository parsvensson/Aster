/**
 * The plugin server's HTTP side (docs/plugin.md): the built app as static files, and the bridge to
 * the tabs that load it: `/__bridge/events` (server to tab, an event stream) and `/__bridge/send`
 * (tab to server). Node's own http, no dependency. Answers this computer only.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
	EVENTS,
	type BridgeResponse,
	type Changed,
	type Hello,
	type Save,
	type Saved
} from '#lib/bridge/protocol.ts';
import type { Broker, Send } from './broker.ts';
import { isLocal, sameOrigin } from './local.ts';

export const BRIDGE_PATH = '/__bridge';
const BODY_MAX = 256 * 1024 * 1024;
const BEAT_MS = 25_000;

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8'
};

/**
 * No offline cache here: the app comes from this computer, and a cached copy would outlive a
 * plugin update. This worker replaces any earlier one and handles nothing.
 */
const NO_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
`;

export interface BridgeHttpOptions {
	/** The built app (`vite build`'s output). */
	appDir: string;
	broker: Broker;
	/** A tab said hello (connected, focused, opened a project). */
	onHello?: (key: object, hello: Hello) => void;
	/** A tab sent its file's text; the answer goes back to it. */
	onSave?: (save: Save) => Saved;
}

interface Tab {
	key: object;
	res: ServerResponse;
}

const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/** The file a path names: itself, its `.html`, or its `index.html`; null when there is none. */
export function staticFile(appDir: string, pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes('\0')) return null;
	const root = resolve(appDir);
	const path = join(root, normalize(decoded));
	if (path !== root && !path.startsWith(root + sep)) return null;
	const bare = path.replace(/[/\\]+$/, '');
	for (const candidate of [path, `${bare}.html`, join(path, 'index.html')])
		if (isFile(candidate)) return candidate;
	return null;
}

export function createBridgeHttp(opts: BridgeHttpOptions): Server {
	const { appDir, broker } = opts;
	const tabs = new Map<string, Tab>();
	const sendTo =
		(id: string): Send =>
		(event, payload) => {
			tabs.get(id)?.res.write(`data: ${JSON.stringify({ event, payload })}\n\n`);
		};

	const events = (req: IncomingMessage, res: ServerResponse, id: string | null) => {
		if (!id || !/^[\w-]{8,64}$/.test(id)) return end(res, 400, 'A tab id is needed.');
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		});
		// The same tab coming back (its stream dropped) keeps its place; the old stream ends.
		const before = tabs.get(id);
		const tab: Tab = { key: before?.key ?? {}, res };
		tabs.set(id, tab);
		before?.res.end();
		sendTo(id)(EVENTS.who);
		const beat = setInterval(() => res.write(': beat\n\n'), BEAT_MS);
		res.on('close', () => {
			clearInterval(beat);
			if (tabs.get(id) !== tab) return;
			tabs.delete(id);
			broker.gone(tab.key);
		});
	};

	const receive = (req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > BODY_MAX) {
				end(res, 413, 'Too large.');
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => {
			if (res.writableEnded) return;
			let msg: { tab?: unknown; event?: unknown; payload?: unknown };
			try {
				msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				return end(res, 400, 'Not JSON.');
			}
			const id = typeof msg.tab === 'string' ? msg.tab : '';
			const tab = tabs.get(id);
			if (!tab) return end(res, 409, 'This tab has no event stream open.');
			switch (msg.event) {
				case EVENTS.hello:
					broker.hello(tab.key, sendTo(id), msg.payload as Hello);
					opts.onHello?.(tab.key, msg.payload as Hello);
					break;
				case EVENTS.response:
					broker.response(msg.payload as BridgeResponse);
					break;
				case EVENTS.changed:
					broker.changed(msg.payload as Changed);
					break;
				case EVENTS.save: {
					const save = msg.payload as Save;
					const saved: Saved = opts.onSave?.(save) ?? {
						path: save.path,
						version: save.version,
						ok: false,
						error: 'This server writes no files.'
					};
					sendTo(id)(EVENTS.saved, saved);
					break;
				}
				default:
					return end(res, 400, 'Unknown event.');
			}
			end(res, 204);
		});
	};

	const serve = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
		if (pathname === '/service-worker.js') {
			res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
			return res.end(req.method === 'HEAD' ? undefined : NO_WORKER);
		}
		// `/design/<slug>` is resolved in the browser: every unknown path gets the editor's shell,
		// as the public site serves it.
		const file = staticFile(appDir, pathname) ?? staticFile(appDir, '/404.html');
		if (!file) return end(res, 404, 'The Aster app is not built here.');
		res.writeHead(200, {
			'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
			'cache-control': pathname.startsWith('/_app/immutable/')
				? 'public, max-age=31536000, immutable'
				: 'no-cache'
		});
		if (req.method === 'HEAD') return res.end();
		createReadStream(file)
			.on('error', () => res.destroy())
			.pipe(res);
	};

	return createServer((req, res) => {
		if (!isLocal(req)) return end(res, 403, 'The Aster bridge answers the local computer only.');
		const url = new URL(req.url ?? '/', 'http://localhost');
		const path = url.pathname;
		if (path === BRIDGE_PATH || path.startsWith(`${BRIDGE_PATH}/`)) {
			if (!sameOrigin(req)) return end(res, 403, 'The Aster bridge answers its own pages only.');
			if (req.method === 'GET' && path === `${BRIDGE_PATH}/ping`) {
				res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
				return res.end(JSON.stringify({ aster: true }));
			}
			if (req.method === 'GET' && path === `${BRIDGE_PATH}/events`)
				return events(req, res, url.searchParams.get('tab'));
			if (req.method === 'POST' && path === `${BRIDGE_PATH}/send`) return receive(req, res);
			return end(res, 404, 'No such bridge path.');
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'GET only.');
		serve(req, res, path);
	});
}

function end(res: ServerResponse, status: number, text?: string) {
	if (res.headersSent) return void res.end();
	res.writeHead(status, text ? { 'content-type': MIME['.txt'] } : {});
	res.end(text);
}
