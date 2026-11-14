/**
 * The bridge's channel over plain HTTP (docs/plugin.md), for the built app as the Claude plugin's
 * server serves it: the server's events arrive on an EventSource, the tab's go out as POSTs, in
 * order. `/__bridge/ping` answers only on that server, so everywhere else there is no channel.
 */
import type { Channel } from './protocol.ts';

export const BRIDGE_PATH = '/__bridge';

type Listener = (payload: never) => void;

export interface HttpChannel extends Channel {
	close(): void;
}

/** The hosts a bridge may live on: this computer, never the public site. */
export const isLocalHost = (hostname: string) =>
	hostname === 'localhost' ||
	hostname === '127.0.0.1' ||
	hostname === '[::1]' ||
	hostname.endsWith('.localhost');

export async function httpChannel(base = BRIDGE_PATH): Promise<HttpChannel | null> {
	try {
		const r = await fetch(`${base}/ping`, { cache: 'no-store' });
		if (!r.ok || ((await r.json()) as { aster?: unknown }).aster !== true) return null;
	} catch {
		return null;
	}
	// One id per page load: a reloaded tab is a new tab to the server.
	const tab = crypto.randomUUID();
	const listeners = new Map<string, Set<Listener>>();
	const source = new EventSource(`${base}/events?tab=${tab}`);
	source.onmessage = (ev) => {
		const { event, payload } = JSON.parse(String(ev.data)) as { event: string; payload?: unknown };
		for (const fn of listeners.get(event) ?? []) fn(payload as never);
	};
	let queue: Promise<void> = Promise.resolve();
	return {
		on(event, fn) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(fn);
		},
		off(event, fn) {
			listeners.get(event)?.delete(fn);
		},
		send(event, payload) {
			const body = JSON.stringify({ tab, event, payload });
			queue = queue.then(() =>
				fetch(`${base}/send`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body
				}).then(
					() => undefined,
					() => undefined
				)
			);
		},
		close() {
			source.close();
			listeners.clear();
		}
	};
}
