/**
 * The Vite plugin that is the MCP bridge (docs/mcp.md), dev server only: an MCP endpoint at
 * `/__mcp` (Streamable HTTP, stateless, JSON responses) for Claude Code, and the tab's side of
 * the conversation over Vite's own HMR socket. Nothing here reaches a production build.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Plugin, WebSocketClient } from 'vite';
import type { Changed, Hello, BridgeResponse } from '#lib/bridge/protocol.ts';
import { Broker } from './broker.ts';
import { isLocal } from './local.ts';
import { createMcpServer } from './server.ts';

export const MCP_PATH = '/__mcp';

export { isLocal };

export interface AsterMcpOptions {
	path?: string;
	/** How long a tool call waits for the tab. */
	timeoutMs?: number;
	/** Apply even under vitest (the integration test); never set it in vite.config.ts. */
	force?: boolean;
	/** The broker to use, so a test can watch it; one is made when left out. */
	broker?: Broker;
}

export function asterMcp(opts: AsterMcpOptions = {}): Plugin {
	const path = opts.path ?? MCP_PATH;
	return {
		name: 'aster-mcp',
		// `pnpm dev` only: not the build, not the preview server, not vitest's server.
		apply: (config, env) =>
			env.command === 'serve' &&
			!env.isPreview &&
			(opts.force === true || (config.mode !== 'test' && !process.env.VITEST)),
		configureServer(server) {
			const broker = opts.broker ?? new Broker(opts.timeoutMs);
			const key = (client: WebSocketClient): object => client.socket;

			// A socket (re)connected: a tab that loaded before this server started, or one whose
			// socket came back, says hello again when asked. Only that socket is asked, so the
			// tabs already here keep their order; only tabs answer.
			server.ws.on('connection', (socket) =>
				socket.send(JSON.stringify({ type: 'custom', event: 'aster:who' }))
			);

			server.ws.on('aster:hello', (data: Hello, client) => {
				const k = key(client);
				const fresh = !broker.tabs.some((t) => t.key === k);
				broker.hello(k, (event, payload) => client.send(event, payload), data);
				if (fresh) client.socket.once('close', () => broker.gone(k));
			});
			server.ws.on('aster:res', (data: BridgeResponse) => broker.response(data));
			server.ws.on('aster:changed', (data: Changed) => broker.changed(data));

			server.middlewares.use(path, (req, res) => {
				if (!isLocal(req)) {
					res.statusCode = 403;
					res.end('The Aster MCP bridge answers the local computer only.');
					return;
				}
				// Stateless: a server and a transport per request, closed with the response.
				const mcp = createMcpServer(broker);
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true
				});
				res.once('close', () => {
					void transport.close();
					void mcp.close();
				});
				mcp
					.connect(transport)
					.then(() => transport.handleRequest(req, res))
					.catch((e: unknown) => {
						server.config.logger.error(`[aster-mcp] ${e instanceof Error ? e.message : e}`);
						if (!res.headersSent) {
							res.statusCode = 500;
							res.end('MCP request failed');
						}
					});
			});

			server.httpServer?.once('listening', () => {
				const port = server.config.server.port;
				server.config.logger.info(
					`  ➜  MCP:     http://localhost:${port}${path}  (Claude Code reads .mcp.json)`
				);
			});
		}
	};
}
