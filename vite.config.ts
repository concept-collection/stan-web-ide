import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import { minwebide } from 'minwebide/vite';

// Cross-origin isolation makes SharedArrayBuffer available — the compiled
// Stan modules are built with pthreads (chains run in parallel threads).
// Dev/preview get it from plain response headers — no service worker
// involved. Production builds are for GitHub Pages, which can't set headers,
// so only there the coi-serviceworker is injected.
const coiHeaders = {
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Opener-Policy': 'same-origin',
};

const injectCoiServiceWorker = {
	name: 'inject-coi-serviceworker',
	apply: 'build' as const,
	transformIndexHtml() {
		// relative src so it resolves under the DEPLOY_BASE sub-path
		return [{ tag: 'script', attrs: { src: 'coi-serviceworker.js' }, injectTo: 'head' as const }];
	},
};

// DEPLOY_BASE is set by CI when building for GitHub Pages
// (the site is served from /stan-web-ide/, not the domain root).
//
// Ports: the stock stan-wasm-server docker image only allows the origins
// http://127.0.0.1:3000 and http://127.0.0.1:4173 in its CORS config, so
// dev runs on 3000 (open the 127.0.0.1 URL, not localhost) and preview on
// Vite's default 4173.
export default defineConfig(mergeConfig(minwebide(), {
	base: process.env.DEPLOY_BASE ?? '/',
	plugins: [injectCoiServiceWorker],
	resolve: {
		alias: {
			// stan-language-server imports node's 'path' (join only)
			path: fileURLToPath(new URL('./src/stan/pathShim.ts', import.meta.url)),
		},
	},
	// host 127.0.0.1 (not 'localhost', which may bind IPv6-only): the page
	// origin must be exactly http://127.0.0.1:<port> for the server's CORS
	server: { host: '127.0.0.1', port: 3000, headers: coiHeaders },
	preview: { host: '127.0.0.1', port: 4173, headers: coiHeaders },
}));
