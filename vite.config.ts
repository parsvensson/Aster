import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { asterMcp } from './scripts/mcp/plugin.ts';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// `/design/<slug>` is resolved on the client; unknown paths get the fallback shell.
			adapter: adapter({ fallback: '404.html' })
		}),
		// Claude Code's way into the open tab (docs/mcp.md); `pnpm dev` only.
		asterMcp()
	],
	// A fixed port, so .mcp.json can name the bridge's URL.
	server: { port: 5173, strictPort: true },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				// The docs' playground logic is tested from here, and docs-site/tsconfig.json extends
				// Astro's, which CI does not install: every file compiles with the app's tsconfig.
				tsconfig: './tsconfig.json',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['tests/unit/**/*.test.ts']
				}
			}
		]
	}
});
