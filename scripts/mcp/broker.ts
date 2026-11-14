/**
 * The dev server's side of the bridge (docs/mcp.md): which tabs are connected, which one answers,
 * the requests in flight, and a short log of what changed. Knows nothing of Vite or MCP; the
 * plugin feeds it socket events and the MCP tools call `request`.
 */
import type {
	BridgeRequest,
	BridgeResponse,
	Changed,
	ErrorCode,
	Hello,
	Method,
	Params,
	Results,
	TabInfo
} from '#lib/bridge/protocol.ts';

export type Send = (event: string, payload?: unknown) => void;

export interface Tab {
	/** The socket, as the plugin identifies it. */
	key: object;
	send: Send;
	hello: Hello;
	/** When it last said hello (connect, focus, project opened). */
	at: number;
}

export class BrokerError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string
	) {
		super(message);
	}
}

interface Pending {
	resolve: (res: BridgeResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

export const CHANGES_MAX = 200;

export class Broker {
	#tabs = new Map<object, Tab>();
	#active: Tab | null = null;
	#pending = new Map<string, Pending>();
	#changes: Changed[] = [];
	#n = 0;

	constructor(
		readonly timeoutMs = 10_000,
		private readonly now: () => number = () => Date.now()
	) {}

	/** The tab that answers: the one that said hello last. */
	get active(): Tab | null {
		return this.#active;
	}
	get tabs(): Tab[] {
		return [...this.#tabs.values()].sort((a, b) => b.at - a.at);
	}
	get changes(): readonly Changed[] {
		return this.#changes;
	}

	/** The tabs for the outside: newest first, the active one marked. */
	get infos(): TabInfo[] {
		return this.tabs.map((t) => ({
			...t.hello,
			at: new Date(t.at).toISOString(),
			active: t === this.#active
		}));
	}

	hello(key: object, send: Send, hello: Hello) {
		const tab: Tab = { key, send, hello, at: this.now() };
		this.#tabs.set(key, tab);
		this.#active = tab;
	}

	/**
	 * Makes the tab whose url, route or project name matches answer from now on (until another
	 * tab says hello: a click into a tab does that). Throws when none or several match.
	 */
	activate(match: string): Tab {
		const q = match.trim().toLowerCase();
		const hits = this.tabs.filter((t) =>
			[t.hello.url, t.hello.route ?? '', t.hello.project].some((v) => v.toLowerCase() === q)
		);
		if (hits.length === 1) {
			this.#active = hits[0];
			return hits[0];
		}
		const list = this.tabs.map((t) => `${t.hello.project} (${t.hello.url})`).join(', ');
		throw new BrokerError(
			hits.length ? 'ambiguous' : 'no_tab',
			hits.length
				? `${hits.length} tabs match ${match}: ${list}. Use the url.`
				: `No connected tab matches ${match}. Connected: ${list || 'none'}.`
		);
	}

	gone(key: object) {
		this.#tabs.delete(key);
		if (this.#active?.key === key) this.#active = this.tabs[0] ?? null;
	}

	response(res: BridgeResponse) {
		const p = this.#pending.get(res.id);
		if (!p) return;
		clearTimeout(p.timer);
		this.#pending.delete(res.id);
		p.resolve(res);
	}

	changed(c: Changed) {
		this.#changes.push(c);
		if (this.#changes.length > CHANGES_MAX)
			this.#changes.splice(0, this.#changes.length - CHANGES_MAX);
	}

	/** What happened after `version`, oldest first. */
	changesSince(version: number): Changed[] {
		return this.#changes.filter((c) => c.version > version);
	}

	/** Asks the active tab; rejects with a `BrokerError` when there is none, it is slow, or it says no. */
	request<M extends Method>(method: M, params: Params[M]): Promise<Results[M]> {
		const tab = this.#active;
		if (!tab)
			return Promise.reject(
				new BrokerError(
					'no_tab',
					'No Aster tab is connected. Open http://localhost:5173/ in a browser while `pnpm dev` runs.'
				)
			);
		const id = `r${++this.#n}`;
		const req: BridgeRequest<M> = { id, method, params };
		return new Promise<Results[M]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(
					new BrokerError(
						'timeout',
						`The tab did not answer ${method} within ${this.timeoutMs} ms. Is it still open?`
					)
				);
			}, this.timeoutMs);
			this.#pending.set(id, {
				timer,
				resolve: (res) => {
					if (res.ok) resolve(res.result as Results[M]);
					else reject(new BrokerError(res.code, res.error));
				}
			});
			tab.send('aster:req', req);
		});
	}
}
