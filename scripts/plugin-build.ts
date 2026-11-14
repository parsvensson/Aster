// Builds the Claude plugin (docs/plugin.md) into plugin/: the app as `vite build` makes it
// (plugin/app) and the MCP server with its dependencies in one file (plugin/server.js). Both are
// checked in, so installing the plugin needs Node and nothing else. Run `pnpm plugin:build` after
// a change to the app or to scripts/mcp, and commit the result.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
rmSync(at('plugin/app'), { recursive: true, force: true });
cpSync(at('build'), at('plugin/app'), { recursive: true });
// The plugin's server answers for the service worker itself, and nothing crawls a local port.
for (const f of ['service-worker.js', 'sitemap.xml', 'robots.txt', 'og.png'])
	rmSync(at(`plugin/app/${f}`), { force: true });

await build({
	configFile: false,
	root,
	logLevel: 'warn',
	publicDir: false,
	build: {
		ssr: at('scripts/mcp/main.ts'),
		outDir: at('plugin'),
		emptyOutDir: false,
		minify: false,
		target: 'node24',
		rolldownOptions: { output: { entryFileNames: 'server.js', codeSplitting: false } }
	},
	ssr: { noExternal: true, target: 'node' }
});

console.log(`plugin/server.js ${(statSync(at('plugin/server.js')).size / 1024).toFixed(0)} kB`);
