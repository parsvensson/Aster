/**
 * The plugin server's entry (docs/plugin.md): Claude Code starts it over stdio. Bundled with its
 * dependencies into `plugin/server.js` by `pnpm plugin:build`; the built app sits beside it.
 * stdout belongs to MCP: everything said here goes to stderr.
 */
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPluginServer, DEFAULT_PORT } from './standalone.ts';

const log = (line: string) => process.stderr.write(`[aster] ${line}\n`);

const server = createPluginServer({
	root: process.env.ASTER_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
	appDir: process.env.ASTER_APP_DIR || join(import.meta.dirname, 'app'),
	log
});

const stop = () => {
	void server.close().finally(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
};
process.stdin.on('close', stop);
process.stdin.on('end', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
	const url = await server.listen(Number(process.env.ASTER_PORT) || DEFAULT_PORT);
	log(`app and bridge at ${url}, files in ${server.disk.root}`);
	await server.mcp.connect(new StdioServerTransport());
} catch (e) {
	log(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
