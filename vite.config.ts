import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import { minwebide } from 'minwebide/vite';

// DEPLOY_BASE is set by CI when building for GitHub Pages
// (the site is served from /stan-web-ide/, not the domain root).
//
// No special headers are needed: the compiled Stan models are pure-WASI
// modules run single-threaded, one worker per chain — no SharedArrayBuffer,
// so no cross-origin isolation. The compile server allows any origin.
export default defineConfig(mergeConfig(minwebide(), {
	base: process.env.DEPLOY_BASE ?? '/',
	resolve: {
		alias: {
			// stan-language-server imports node's 'path' (join only)
			path: fileURLToPath(new URL('./src/stan/pathShim.ts', import.meta.url)),
		},
	},
	// fixed host/port only so the check scripts know where to look
	server: { host: '127.0.0.1', port: 3000 },
	preview: { host: '127.0.0.1', port: 4173 },
}));
